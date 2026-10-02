import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB, KyselyTransaction } from '@docmost/db/types/kysely.types';
import {
  Chunker,
  DocumentKey,
  DocumentParser,
  EmbeddingPort,
  GenerationStore,
  IndexProfile,
  IndexProfileConfig,
  RagProfileResolver,
  IndexRequest,
  InputRevision,
  RagErrorCode,
  RagError,
  RagIndexer,
  RagIndexerResult,
  RAG_CHUNKER,
  RAG_DOCUMENT_PARSER,
  RAG_EMBEDDING_PORT,
  RAG_GENERATION_STORE,
  RAG_PROFILE_RESOLVER,
  RAG_SOURCE_READER,
  SourceReader,
} from './contracts';
import { RagStateRepository } from './persistence/rag-state.repository';
import { effectiveIndexingStrategy } from './retrieval/retrieval-config';

/**
 * Cooperative cancellation between the ordered steps. Throwing a plain error
 * (not a RagError) keeps the queue's retry policy in charge: nothing terminal
 * was recorded, so a redelivery re-evaluates the claim gates from scratch.
 */
export class RagIndexerCancelledError extends Error {
  constructor(message: string) {
    super(`RAG indexing was cancelled: ${message}`);
    this.name = 'RagIndexerCancelledError';
  }
}

/** Transient failures go back to the queue's bounded retry policy. */
const RETRYABLE_ERROR_CODES: readonly RagErrorCode[] = [
  'EMBEDDING_UNAVAILABLE',
  'EMBEDDING_RESPONSE_INVALID',
  'INDEX_WRITE_FAILED',
];

/**
 * Orchestrates the docmost-rag-v1 contract 11 ordered work: claim current
 * revision -> loadSnapshot -> normalize -> split -> embed -> stage ->
 * publishIfCurrent (the store retires stale generations in the same
 * transaction as the publication). Delete requests use guarded purge.
 *
 * Profile resolution sits between claim and snapshot: the claim gate owns the
 * revision/lifecycle decision, and normalize/split need the resolved profile.
 * No model call runs inside a database save transaction: embed() executes
 * outside any transaction, and stage/publish commit in short store-owned
 * transactions. Configuration/source errors persist a durable failed
 * generation row and return state 'failed'; transient errors rethrow so the
 * queue's bounded retry policy applies.
 */
@Injectable()
export class RagIndexerService implements RagIndexer {
  private readonly logger = new Logger(RagIndexerService.name);

  constructor(
    @Inject(RAG_PROFILE_RESOLVER)
    private readonly profileResolver: RagProfileResolver,
    @Inject(RAG_SOURCE_READER)
    private readonly sourceReader: SourceReader,
    @Inject(RAG_DOCUMENT_PARSER)
    private readonly parser: DocumentParser,
    @Inject(RAG_CHUNKER)
    private readonly chunker: Chunker,
    @Inject(RAG_EMBEDDING_PORT)
    private readonly embedding: EmbeddingPort,
    @Inject(RAG_GENERATION_STORE)
    private readonly generationStore: GenerationStore,
    private readonly stateRepository: RagStateRepository,
    @InjectKysely() private readonly db: KyselyDB,
  ) {}

  async handle(
    request: IndexRequest,
    options?: { signal?: AbortSignal },
  ): Promise<RagIndexerResult> {
    try {
      if (request.operation === 'delete') {
        return await this.handleDelete(request);
      }
      return await this.handleUpsert(request, options);
    } catch (error) {
      if (
        error instanceof RagError &&
        !RETRYABLE_ERROR_CODES.includes(error.code)
      ) {
        // Configuration/source errors remain visible and await a relevant
        // correction; they are terminal for this delivery, not retries.
        await this.recordFailure(request, error.code);
        return {
          state: 'failed',
          key: request.key,
          inputRevision: request.inputRevision,
        };
      }
      throw error;
    }
  }

  /**
   * Persists the durable failed phase for a terminal attempt. The row is
   * conditional on the requested revision still being desired and the source
   * being live, so a stale worker cannot paint a newer revision as failed.
   * profileHash stays empty when no profile was ever resolved; the status
   * derivation reads only the newest failed row at the desired revision.
   */
  async recordFailure(
    request: IndexRequest,
    errorCode: RagErrorCode,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const state = await trx
        .selectFrom('ragSourceState')
        .selectAll()
        .where('workspaceId', '=', request.key.workspaceId)
        .where('pageId', '=', request.key.pageId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !state ||
        state.sourceStatus !== 'live' ||
        state.desiredInputRevision !== request.inputRevision
      ) {
        return;
      }
      const existing = await trx
        .selectFrom('ragGenerations')
        .select('id')
        .where('workspaceId', '=', request.key.workspaceId)
        .where('pageId', '=', request.key.pageId)
        .where('inputRevision', '=', request.inputRevision)
        .where('status', '=', 'failed')
        .where('errorCode', '=', errorCode)
        .executeTakeFirst();
      if (existing) return;
      const profile = await this.stateRepository.findWorkspaceProfile(
        trx,
        request.key.workspaceId,
      );
      await trx
        .insertInto('ragGenerations')
        .values({
          workspaceId: request.key.workspaceId,
          pageId: request.key.pageId,
          inputRevision: request.inputRevision,
          profileHash: profile?.profileHash ?? '',
          status: 'failed',
          errorCode,
        })
        .execute();
    });
    this.logger.log(
      `rag-index failed eventId=${request.eventId} pageId=${request.key.pageId} revision=${request.inputRevision} code=${errorCode}`,
    );
  }

  private async handleDelete(request: IndexRequest): Promise<RagIndexerResult> {
    const state = await this.stateRepository.find(this.db, request.key);
    if (
      state &&
      BigInt(state.desiredInputRevision) > BigInt(request.inputRevision)
    ) {
      // A newer source change won; this delete is stale history.
      return {
        state: 'superseded',
        key: request.key,
        inputRevision: request.inputRevision,
      };
    }
    await this.generationStore.purge(request.key, request.inputRevision);
    return {
      state: 'deleted',
      key: request.key,
      inputRevision: request.inputRevision,
    };
  }

  private async handleUpsert(
    request: IndexRequest,
    options?: { signal?: AbortSignal },
  ): Promise<RagIndexerResult> {
    this.throwIfAborted(options?.signal, 'before-claim');

    // Claim: the persisted state row is the only authority for whether this
    // revision is still current, the source is live and indexing is enabled.
    const state = await this.stateRepository.find(this.db, request.key);
    if (!state) {
      return this.terminal(request, 'superseded');
    }
    if (state.sourceStatus !== 'live') {
      return this.terminal(request, 'deleted');
    }
    if (BigInt(state.desiredInputRevision) !== BigInt(request.inputRevision)) {
      return this.terminal(request, 'superseded');
    }
    const profileRow = await this.stateRepository.findWorkspaceProfile(
      this.db,
      request.key.workspaceId,
    );
    if (!profileRow?.enabled) {
      return this.terminal(request, 'disabled');
    }

    const profile = await this.profileResolver.resolve(request.key.workspaceId);

    const snapshot = await this.sourceReader.loadSnapshot(
      request.key,
      request.inputRevision,
    );
    if (snapshot.kind === 'superseded') {
      return this.terminal(request, 'superseded');
    }
    if (snapshot.kind === 'deleted') {
      return this.terminal(request, 'deleted');
    }

    const document = await this.parser.normalize(snapshot.value, profile);
    // A required source the parser could not read blocks readiness (contract
    // 8): the failure stays visible and awaits a relevant correction instead
    // of publishing incomplete content.
    if (
      document.diagnostics.some(
        (diagnostic) => diagnostic.code === 'SOURCE_UNSUPPORTED',
      )
    ) {
      throw new RagError(
        'SOURCE_UNSUPPORTED',
        'a required source could not be parsed; awaiting a relevant correction',
      );
    }
    const batch = await this.chunker.split(document, profile);

    this.throwIfAborted(options?.signal, 'before-embed');
    // The indexing strategy can disable vector embeddings for this profile;
    // keyword-only indexes publish generations whose chunks have no stored
    // vectors, which semantic retrieval drops and keyword retrieval ignores.
    const vectorless =
      (await this.readIndexingStrategy(request.key.workspaceId))
        ?.vectorEnabled === false;
    const embeddingBatch = vectorless
      ? {
          profileHash: profile.profileHash,
          dimensions: profile.embedding.dimensions,
          vectors: [],
        }
      : await this.embedding.embed(
          request.key.workspaceId,
          profile,
          batch.chunks.map((chunk) => ({
            chunkId: chunk.chunkId,
            text: chunk.text,
          })),
        );

    this.throwIfAborted(options?.signal, 'before-stage');
    const staged = await this.generationStore.stage(batch, embeddingBatch, {
      vectorless: vectorless,
    });

    const outcome = await this.generationStore.publishIfCurrent(
      request.key,
      request.inputRevision,
      profile.profileHash,
      staged.generationId,
    );
    if (outcome === 'published') {
      this.logger.log(
        `rag-index published eventId=${request.eventId} pageId=${request.key.pageId} revision=${request.inputRevision} generationId=${staged.generationId} chunks=${batch.chunks.length} diagnostics=${document.diagnostics.length}`,
      );
      return {
        state: 'ready',
        key: request.key,
        inputRevision: request.inputRevision,
        generationId: staged.generationId,
      };
    }
    return this.terminal(request, outcome);
  }

  /** Effective indexing strategy from the owner-controlled stored config. */
  private async readIndexingStrategy(
    workspaceId: string,
  ): Promise<{ vectorEnabled: boolean; keywordEnabled: boolean } | null> {
    const row = await this.db
      .selectFrom('workspaces')
      .select('settings')
      .where('id', '=', workspaceId)
      .executeTakeFirst();
    const stored = (row?.settings as Record<string, unknown> | null)?.[
      'rag'
    ] as
      | { indexProfileConfig?: Pick<IndexProfileConfig, 'indexingStrategy'> }
      | undefined;
    return effectiveIndexingStrategy(stored?.indexProfileConfig ?? null);
  }

  private terminal(
    request: IndexRequest,
    state: 'superseded' | 'deleted' | 'disabled',
  ): RagIndexerResult {
    this.logger.log(
      `rag-index ${state} eventId=${request.eventId} pageId=${request.key.pageId} revision=${request.inputRevision}`,
    );
    return {
      state,
      key: request.key,
      inputRevision: request.inputRevision,
    };
  }

  private throwIfAborted(signal: AbortSignal | undefined, phase: string): void {
    if (signal?.aborted) {
      throw new RagIndexerCancelledError(phase);
    }
  }
}
