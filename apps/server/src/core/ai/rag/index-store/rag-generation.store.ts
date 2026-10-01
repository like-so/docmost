import { Injectable } from '@nestjs/common';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import {
  ChunkBatch,
  DocumentKey,
  EmbeddingBatchResult,
  GenerationStore,
  InputRevision,
  PublishOutcome,
  RagError,
  StageResult,
} from '../contracts';
import { RagStateRepository } from '../persistence/rag-state.repository';

interface UniqueViolation {
  code?: string;
  cause?: { code?: string };
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as UniqueViolation | undefined;
  return candidate?.code === '23505' || candidate?.cause?.code === '23505';
}

/**
 * GenerationStore over the approved rag_generations/rag_chunks schema.
 *
 * stage() is idempotent per (workspaceId, pageId, inputRevision, profileHash):
 * chunk identity is deterministic from document revision, source locator,
 * text and profile, so a duplicate stage or job resolves to the existing
 * generation instead of creating a competing one.
 *
 * publishIfCurrent() validates the generation against the requested
 * revision/profile, then delegates the guarded pointer switch to the
 * foundation CAS. Pointer switch, generation status and retirement of older
 * generations commit in ONE transaction, so a crash leaves either the fully
 * previous state or the fully published state. Retirement is revision-bounded
 * and never touches generations newer than the published revision, so a
 * concurrently staged newer revision survives.
 *
 * purge() removes generations up to throughInputRevision while preserving the
 * generation the publication pointer references at that exact revision, so a
 * newer restored generation and the current active generation survive.
 */
@Injectable()
export class RagGenerationStore implements GenerationStore {
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly stateRepository: RagStateRepository,
  ) {}

  async stage(
    batch: ChunkBatch,
    embeddingBatch: EmbeddingBatchResult,
  ): Promise<StageResult> {
    const vectorsByChunkId = this.validateBatchPairing(batch, embeddingBatch);

    try {
      return await this.db.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom('ragGenerations')
          .selectAll()
          .where('workspaceId', '=', batch.key.workspaceId)
          .where('pageId', '=', batch.key.pageId)
          .where('inputRevision', '=', batch.inputRevision)
          .where('profileHash', '=', batch.profileHash)
          .executeTakeFirst();
        if (existing) {
          return {
            generationId: existing.id,
            chunkCount: existing.chunkCount ?? batch.chunks.length,
          };
        }

        const generation = await trx
          .insertInto('ragGenerations')
          .values({
            workspaceId: batch.key.workspaceId,
            pageId: batch.key.pageId,
            inputRevision: batch.inputRevision,
            profileHash: batch.profileHash,
            status: 'staged',
            chunkCount: batch.chunks.length,
          })
          .returning(['id'])
          .executeTakeFirstOrThrow();

        if (batch.chunks.length > 0) {
          await trx
            .insertInto('ragChunks')
            .values(
              batch.chunks.map((chunk) => ({
                id: chunk.chunkId,
                generationId: generation.id,
                workspaceId: batch.key.workspaceId,
                pageId: batch.key.pageId,
                attachmentId: chunk.locator.attachmentId ?? null,
                ordinal: chunk.ordinal,
                text: chunk.text,
                tokenCount: chunk.tokenCount,
                textHash: chunk.locator.textHash,
                locator: chunk.locator,
                embedding: vectorsByChunkId.get(chunk.chunkId),
                embeddingDimensions: embeddingBatch.dimensions,
              })),
            )
            .execute();
        }

        return {
          generationId: generation.id,
          chunkCount: batch.chunks.length,
        };
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // A concurrent duplicate stage hit the same deterministic chunk ids.
      // The losing transaction rolled back; resolve to the winner's row.
      const winner = await this.db
        .selectFrom('ragGenerations')
        .selectAll()
        .where('workspaceId', '=', batch.key.workspaceId)
        .where('pageId', '=', batch.key.pageId)
        .where('inputRevision', '=', batch.inputRevision)
        .where('profileHash', '=', batch.profileHash)
        .executeTakeFirst();
      if (!winner) throw error;
      return {
        generationId: winner.id,
        chunkCount: winner.chunkCount ?? batch.chunks.length,
      };
    }
  }

  async publishIfCurrent(
    key: DocumentKey,
    inputRevision: InputRevision,
    profileHash: string,
    generationId: string,
  ): Promise<PublishOutcome> {
    return this.db.transaction().execute(async (trx) => {
      const generation = await trx
        .selectFrom('ragGenerations')
        .selectAll()
        .where('id', '=', generationId)
        .executeTakeFirst();

      const matches =
        generation &&
        generation.workspaceId === key.workspaceId &&
        generation.pageId === key.pageId &&
        generation.inputRevision === inputRevision &&
        generation.profileHash === profileHash;

      if (!matches) {
        // The generation can no longer be published (purged or foreign).
        // Report the terminal outcome for the requested source instead of a
        // retryable error.
        const state = await this.stateRepository.find(trx, key);
        return state && state.sourceStatus === 'live'
          ? 'superseded'
          : 'deleted';
      }

      const state = await this.stateRepository.find(trx, key);
      if (
        generation.status === 'published' &&
        state?.publishedGenerationId === generationId &&
        state.publishedInputRevision === inputRevision
      ) {
        return 'published';
      }

      const outcome = await this.stateRepository.compareAndSwapPublication(
        trx,
        key,
        inputRevision,
        profileHash,
        generationId,
      );
      if (outcome !== 'published') return outcome;

      await trx
        .updateTable('ragGenerations')
        .set({
          status: 'published',
          publishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where('id', '=', generationId)
        .where('inputRevision', '=', inputRevision)
        .execute();

      // Retire obsolete generations. Bounded to revisions at or below the
      // published revision: a newer staged revision is another worker's
      // in-flight work and must survive.
      await trx
        .deleteFrom('ragGenerations')
        .where('workspaceId', '=', key.workspaceId)
        .where('pageId', '=', key.pageId)
        .where('inputRevision', '<', inputRevision)
        .execute();
      await trx
        .deleteFrom('ragGenerations')
        .where('workspaceId', '=', key.workspaceId)
        .where('pageId', '=', key.pageId)
        .where('inputRevision', '=', inputRevision)
        .where('id', '!=', generationId)
        .execute();

      return 'published';
    });
  }

  async purge(
    key: DocumentKey,
    throughInputRevision: InputRevision,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const state = await trx
        .selectFrom('ragSourceState')
        .selectAll()
        .where('workspaceId', '=', key.workspaceId)
        .where('pageId', '=', key.pageId)
        .forUpdate()
        .executeTakeFirst();

      let deletion = trx
        .deleteFrom('ragGenerations')
        .where('workspaceId', '=', key.workspaceId)
        .where('pageId', '=', key.pageId)
        .where('inputRevision', '<=', throughInputRevision);

      // Preserve the current generation only at its exact published
      // revision; a pointer below throughInputRevision is stale content of a
      // changed or deleted source and is removed with the rest.
      if (
        state?.publishedGenerationId &&
        state.publishedInputRevision === throughInputRevision
      ) {
        deletion = deletion.where('id', '!=', state.publishedGenerationId);
      }

      await deletion.execute();
    });
  }

  /**
   * Validates the chunk batch / embedding batch pairing before any write:
   * same profileHash, complete one-to-one chunk coverage, and vectors whose
   * declared dimensions hold finite, not-all-zero values. A mismatched
   * profileHash is an index-write consistency failure; malformed vectors are
   * an invalid embedding response. Nothing is written on rejection.
   */
  private validateBatchPairing(
    batch: ChunkBatch,
    embeddingBatch: EmbeddingBatchResult,
  ): Map<string, number[]> {
    if (embeddingBatch.profileHash !== batch.profileHash) {
      throw new RagError(
        'INDEX_WRITE_FAILED',
        'Embedding batch profileHash does not match the chunk batch',
      );
    }
    if (
      !Number.isInteger(embeddingBatch.dimensions) ||
      embeddingBatch.dimensions <= 0
    ) {
      throw new RagError(
        'EMBEDDING_RESPONSE_INVALID',
        'Embedding batch dimensions must be a positive integer',
      );
    }

    const vectorsByChunkId = new Map<string, number[]>();
    for (const vector of embeddingBatch.vectors) {
      if (vectorsByChunkId.has(vector.chunkId)) {
        throw new RagError(
          'EMBEDDING_RESPONSE_INVALID',
          `Embedding batch has duplicate vectors for chunk ${vector.chunkId}`,
        );
      }
      const values = vector.values;
      if (
        !Array.isArray(values) ||
        values.length !== embeddingBatch.dimensions
      ) {
        throw new RagError(
          'EMBEDDING_RESPONSE_INVALID',
          `Embedding vector for chunk ${vector.chunkId} does not have ${embeddingBatch.dimensions} dimensions`,
        );
      }
      let nonzero = false;
      for (const value of values) {
        if (!Number.isFinite(value)) {
          throw new RagError(
            'EMBEDDING_RESPONSE_INVALID',
            `Embedding vector for chunk ${vector.chunkId} contains a non-finite value`,
          );
        }
        if (value !== 0) nonzero = true;
      }
      if (!nonzero) {
        throw new RagError(
          'EMBEDDING_RESPONSE_INVALID',
          `Embedding vector for chunk ${vector.chunkId} is all zeros`,
        );
      }
      vectorsByChunkId.set(vector.chunkId, values);
    }

    for (const chunk of batch.chunks) {
      if (!vectorsByChunkId.has(chunk.chunkId)) {
        throw new RagError(
          'EMBEDDING_RESPONSE_INVALID',
          `Embedding batch is missing a vector for chunk ${chunk.chunkId}`,
        );
      }
    }
    if (vectorsByChunkId.size !== batch.chunks.length) {
      throw new RagError(
        'EMBEDDING_RESPONSE_INVALID',
        'Embedding batch contains vectors outside the chunk batch',
      );
    }

    return vectorsByChunkId;
  }
}
