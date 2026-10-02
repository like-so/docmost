import { KyselyTransaction } from '@docmost/db/types/kysely.types';

/**
 * Canonical RAG contracts, version docmost-rag-v1.
 *
 * InputRevision is a decimal string backed by a monotonic database bigint per
 * DocumentKey. It versions all indexing inputs (source changes, index-profile
 * changes, explicit rebuild requests). It is not PageHistory.version,
 * updatedAt or baseSchemaVersion. Queue payloads carry identifiers and
 * revision metadata only, never source bodies, credentials or signed
 * attachment URLs.
 *
 * The legacy page_embeddings rows written by AiIndexService are hash-based
 * search vectors, not learned embeddings; they are never relabeled or reused
 * by the RAG schema.
 */

export const RAG_SCHEMA_VERSION = 1;

declare const inputRevisionBrand: unique symbol;
export type InputRevision = string & {
  readonly [inputRevisionBrand]?: 'InputRevision';
};

export function toInputRevision(
  value: bigint | number | string,
): InputRevision {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`InputRevision must be an integer, got ${value}`);
  }
  return value.toString() as InputRevision;
}

export interface DocumentKey {
  workspaceId: string;
  pageId: string;
}

export type IndexOperation = 'upsert' | 'delete';

export type IndexCause =
  | 'page'
  | 'attachment'
  | 'move'
  | 'restore'
  | 'manual'
  | 'profile';

export interface IndexRequest {
  schemaVersion: typeof RAG_SCHEMA_VERSION;
  eventId: string;
  key: DocumentKey;
  inputRevision: InputRevision;
  operation: IndexOperation;
  cause: IndexCause;
  occurredAt: string;
}

export type RagErrorCode =
  | 'SOURCE_UNSUPPORTED'
  | 'SOURCE_CHANGED'
  | 'SOURCE_DELETED'
  | 'EMBEDDING_NOT_CONFIGURED'
  | 'EMBEDDING_UNAVAILABLE'
  | 'EMBEDDING_RESPONSE_INVALID'
  | 'INDEX_WRITE_FAILED'
  | 'ACCESS_DENIED';

/** Diagnostic-only code: a source excluded by the explicit sourcePolicy. */
export type RagDiagnosticCode = RagErrorCode | 'EXCLUDED_BY_POLICY';

export class RagError extends Error {
  constructor(
    public readonly code: RagErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'RagError';
  }
}

/**
 * Owner-controlled, nonsecret computation parameters. profileHash
 * deterministically covers ALL of these parameters; every ChunkBatch,
 * EmbeddingBatch, staged generation and query uses that SAME hash. The
 * config never contains plaintext credentials: endpointIdentity is the
 * identity of existing encrypted provider settings.
 */
export interface SourcePolicy {
  requiredMimeTypes: string[];
  imageInterpretation: 'disabled' | 'required';
}

export interface EmbeddingProfileConfig {
  driver: string;
  endpointIdentity: string | null;
  model: string;
  dimensions: number;
  tokenizerId: string | null;
  maxInputTokens: number;
}

/**
 * Owner-controlled indexing channels. Legacy profiles stored before this
 * field existed keep their exact profile hash: the hash covers the field only
 * when it is explicitly present, and consumers default it to both enabled.
 */
export interface IndexingStrategy {
  vectorEnabled: boolean;
  keywordEnabled: boolean;
}

export interface IndexProfileConfig {
  parserVersion: string;
  chunkerVersion: string;
  maxChunkTokens: number;
  overlapTokens: number;
  sourcePolicy: SourcePolicy;
  embedding: EmbeddingProfileConfig;
  indexingStrategy?: IndexingStrategy;
}

export interface IndexProfile extends IndexProfileConfig {
  profileId: string;
  profileHash: string;
}

export interface DocumentSnapshot {
  key: DocumentKey;
  inputRevision: InputRevision;
  title: string | null;
  spaceId: string;
  bodyJson: unknown;
  bodyText: string;
  attachments: SnapshotAttachment[];
}

export interface SnapshotAttachment {
  attachmentId: string;
  fileName: string;
  mimeType: string | null;
  byteSize: number | null;
  sourceHash: string | null;
  /** Internal storage reference, never a public or signed URL. */
  storageRef: string;
}

export type SnapshotOutcome =
  | { kind: 'snapshot'; value: DocumentSnapshot }
  | { kind: 'superseded' }
  | { kind: 'deleted' };

export interface SectionSource {
  kind: 'page' | 'attachment';
  attachmentId?: string;
}

export interface ParseDiagnostic {
  sourceId: string;
  code: RagDiagnosticCode;
}

export interface NormalizedSection {
  source: SectionSource;
  headingPath: string[];
  blockId?: string | null;
  pageNumber?: number | null;
  text: string;
  textHash: string;
}

export interface NormalizedDocument {
  key: DocumentKey;
  inputRevision: InputRevision;
  sections: NormalizedSection[];
  diagnostics: ParseDiagnostic[];
}

export interface ChunkLocator {
  pageId: string;
  attachmentId?: string | null;
  headingPath: string[];
  blockId?: string | null;
  pageNumber?: number | null;
  start: number;
  end: number;
  offsetUnit: 'utf16';
  textHash: string;
}

export interface Chunk {
  chunkId: string;
  ordinal: number;
  text: string;
  tokenCount: number;
  locator: ChunkLocator;
}

export interface ChunkBatch {
  key: DocumentKey;
  inputRevision: InputRevision;
  profileHash: string;
  chunks: Chunk[];
}

export interface EmbeddingInput {
  chunkId: string;
  text: string;
}

export interface EmbeddingVector {
  chunkId: string;
  values: number[];
}

export interface EmbeddingBatchResult {
  profileHash: string;
  dimensions: number;
  vectors: EmbeddingVector[];
}

export interface EmbeddingQueryResult {
  profileHash: string;
  dimensions: number;
  values: number[];
}

export type PublishOutcome =
  | 'published'
  | 'superseded'
  | 'deleted'
  | 'disabled';

export type IndexerState =
  | 'ready'
  | 'superseded'
  | 'deleted'
  | 'disabled'
  | 'failed';

export interface RagIndexerResult {
  state: IndexerState;
  key: DocumentKey;
  inputRevision: InputRevision;
  generationId?: string;
}

export type RagRetrievalMode = 'semantic' | 'keyword' | 'hybrid';

export interface RagActor {
  userId: string;
  workspaceId: string;
}

export interface RagRetrieverQuery {
  query: string;
  spaceId?: string;
  pageIds?: string[];
  mode: RagRetrievalMode;
  limit: number;
  /**
   * Per-request retrieval knobs merged over the stored settings before
   * parsing. rerankModel is an optional nullable workspace-authorized model
   * reference: omission or null inherits the flow default, and the server
   * resolves the model against its own provider configuration.
   */
  overrides?: RagRetrievalOverride;
  /**
   * Recall/fusion-only mode: skips the final rerank stage inside the
   * retriever. The chat pipeline uses this so expansion and the single final
   * rerank happen once, at the chat boundary.
   */
  skipRerank?: boolean;
}

/**
 * Per-request overrides of the retrieval knobs. Absent fields keep the
 * stored (or default) values; the merged payload passes through the same
 * normalization as the stored settings. rerankModel null is NOT a disable
 * switch: it resolves through the same flow-default discovery as omission.
 */
export interface RagRetrievalOverride {
  recallCount?: number;
  vectorThreshold?: number;
  keywordThreshold?: number;
  rerankModel?: string | null;
  rerankTopK?: number;
  rerankThreshold?: number;
}

/**
 * Actual-stage retrieval metadata: the mode that executed and whether the
 * rerank stage was applied, unavailable (no model configured), failed, or
 * not applicable (no evidence / non-hybrid mode).
 */
export type RagRerankStatus =
  | 'applied'
  | 'not_configured'
  | 'failed'
  | 'not_applicable';

export interface RagRetrievalMeta {
  mode: RagRetrievalMode;
  rerankStatus: RagRerankStatus;
}

export interface RagEvidence {
  chunkId: string;
  key: DocumentKey;
  inputRevision: InputRevision;
  text: string;
  locator: ChunkLocator;
  score: { kind: 'cosine' | 'keyword' | 'rrf' | 'rerank'; value: number };
}

export interface RagRetrieveResult {
  evidence: RagEvidence[];
  retrieval: RagRetrievalMeta;
}

export interface SourceLedger {
  /**
   * Under the SAME SQL transaction as the authoritative source change,
   * advance desiredInputRevision and insert an outbox record. recordChange is
   * the only producer of revisions. Late work after physical deletion is
   * rejected by the persisted tombstone; workers cannot recreate source
   * state.
   */
  recordChange(
    trx: KyselyTransaction,
    key: DocumentKey,
    operation: IndexOperation,
    cause: IndexCause,
  ): Promise<IndexRequest>;
}

export interface SourceReader {
  loadSnapshot(
    key: DocumentKey,
    expectedInputRevision: InputRevision,
  ): Promise<SnapshotOutcome>;
}

export interface DocumentParser {
  normalize(
    snapshot: DocumentSnapshot,
    indexProfile: IndexProfile,
  ): Promise<NormalizedDocument>;
}

export interface Chunker {
  split(
    document: NormalizedDocument,
    profile: IndexProfile,
  ): Promise<ChunkBatch>;
}

export interface RagProfileResolver {
  /** Reads owner-controlled settings and excludes all credential values. */
  resolve(workspaceId: string): Promise<IndexProfile>;
}

export interface EmbeddingPort {
  embed(
    workspaceId: string,
    indexProfile: IndexProfile,
    inputs: EmbeddingInput[],
  ): Promise<EmbeddingBatchResult>;
  embedQuery(
    workspaceId: string,
    indexProfile: IndexProfile,
    query: string,
  ): Promise<EmbeddingQueryResult>;
}

export interface StageResult {
  generationId: string;
  chunkCount: number;
}

export interface GenerationStore {
  /**
   * Stages a chunk batch with its aligned embedding batch. `vectorless`
   * marks a keyword-only indexing strategy: the store then requires an empty
   * embedding batch and publishes chunks without vectors. Without it, the
   * strict one-vector-per-chunk pairing checks apply unchanged.
   */
  stage(
    batch: ChunkBatch,
    embeddingBatch: EmbeddingBatchResult,
    options?: { vectorless?: boolean },
  ): Promise<StageResult>;
  publishIfCurrent(
    key: DocumentKey,
    inputRevision: InputRevision,
    profileHash: string,
    generationId: string,
  ): Promise<PublishOutcome>;
  purge(key: DocumentKey, throughInputRevision: InputRevision): Promise<void>;
}

export interface RagIndexer {
  handle(request: IndexRequest): Promise<RagIndexerResult>;
}

export interface RagRetriever {
  retrieve(
    actor: RagActor,
    query: RagRetrieverQuery,
  ): Promise<RagRetrieveResult>;
}

/**
 * Workspace search defaults (owner-controlled, stored outside the index
 * profile so changing them never rebuilds embeddings). Defaults follow the
 * pinned reference (WeKnora bccb4b1) effective values: recallCount 50,
 * vectorThreshold 0.15, keywordThreshold 0.3, rerankTopK 10,
 * rerankThreshold 0.2.
 */
export interface RagRetrievalSettings {
  recallCount: number;
  vectorThreshold: number;
  keywordThreshold: number;
  rerankModel: string | null;
  rerankTopK: number;
  rerankThreshold: number;
}

/**
 * Chat query-understanding defaults (owner-controlled, stored outside the
 * index profile). Chat carries ALL independent RetrievalConfig fields in
 * addition to the rewrite/expansion extras, so chat recall and rerank read
 * the chat defaults, never the search defaults. Retrieval defaults follow
 * the pinned reference (WeKnora bccb4b1); prompt/model defaults follow the
 * pinned reference conversation config: rewrite and expansion enabled, the
 * default_rewrite template, temperature 0.3 and a 150-token completion
 * budget. queryUnderstandingModel null falls back to the workspace provider
 * chat model.
 */
export interface RagChatRetrievalSettings extends RagRetrievalSettings {
  rewriteEnabled: boolean;
  expansionEnabled: boolean;
  queryUnderstandingModel: string | null;
  rewriteSystemPrompt: string;
  rewriteUserPrompt: string;
}

export interface RagRetrievalSettingsView {
  search: RagRetrievalSettings;
  chat: RagChatRetrievalSettings;
}

/**
 * Rerank stage outcome. `ok` carries model relevance scores in [0, 1]
 * aligned with the passages. `not_configured` means no usable model/provider
 * is configured for the workspace; `failed` means a configured model call
 * did not return usable scores. Callers preserve retrieval order for both
 * non-ok outcomes and record the distinction in retrieval metadata.
 */
export type RagRerankResult =
  | { status: 'ok'; scores: number[] }
  | { status: 'not_configured' }
  | { status: 'failed' };

/**
 * Rerank port. Implementations send no unauthorized text: callers pass only
 * actor-authorized evidence. The score values are model relevance scores
 * aligned with the passages; implementations must validate complete finite
 * score coverage before reporting `ok`.
 */
export interface RagRerankPort {
  rerank(
    workspaceId: string,
    model: string,
    query: string,
    passages: string[],
  ): Promise<RagRerankResult>;
}

export const RAG_SOURCE_LEDGER = Symbol('RAG_SOURCE_LEDGER');
export const RAG_SOURCE_READER = Symbol('RAG_SOURCE_READER');
export const RAG_DOCUMENT_PARSER = Symbol('RAG_DOCUMENT_PARSER');
export const RAG_CHUNKER = Symbol('RAG_CHUNKER');
export const RAG_PROFILE_RESOLVER = Symbol('RAG_PROFILE_RESOLVER');
export const RAG_EMBEDDING_PORT = Symbol('RAG_EMBEDDING_PORT');
export const RAG_GENERATION_STORE = Symbol('RAG_GENERATION_STORE');
export const RAG_INDEXER = Symbol('RAG_INDEXER');
export const RAG_RETRIEVER = Symbol('RAG_RETRIEVER');
export const RAG_RERANK_PORT = Symbol('RAG_RERANK_PORT');

/**
 * HTTP adapter payload types (owned by the HTTP component). POST-style
 * /api/ai routes with existing JWT/AuthUser/AuthWorkspace guards;
 * settings routes are workspace-owner-only. indexProfileConfig carries the
 * identity of existing encrypted provider settings, never credentials.
 */
export type RagStatusPhase =
  | 'disabled'
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'deleted';

export interface RagSettingsView {
  enabled: boolean;
  indexProfile: IndexProfile | null;
}

export interface RagSettingsUpdatePayload {
  enabled: boolean;
  indexProfileConfig: IndexProfileConfig;
}

export interface RagStatusResponse {
  pageId: string;
  desiredInputRevision: InputRevision;
  publishedInputRevision: InputRevision | null;
  phase: RagStatusPhase;
  generationId?: string;
  errorCode?: RagErrorCode;
  updatedAt: string;
}

export interface RagReindexResponse {
  eventId: string;
  inputRevision: InputRevision;
  phase: 'pending';
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIMAL_PATTERN = /^\d+$/;

const INDEX_OPERATIONS: readonly IndexOperation[] = ['upsert', 'delete'];
const INDEX_CAUSES: readonly IndexCause[] = [
  'page',
  'attachment',
  'move',
  'restore',
  'manual',
  'profile',
];

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isIso8601(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

/**
 * Validates an untrusted queue payload as an exact docmost-rag-v1
 * IndexRequest. The queue payload schema is the serialized request itself:
 * identifiers and revision metadata only.
 */
export function parseIndexRequest(payload: unknown): IndexRequest {
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw new Error('IndexRequest payload is not valid JSON');
    }
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('IndexRequest payload must be an object');
  }
  const request = payload as Record<string, unknown>;
  if (request.schemaVersion !== RAG_SCHEMA_VERSION) {
    throw new Error('IndexRequest schemaVersion must be 1');
  }
  if (!isUuid(request.eventId)) {
    throw new Error('IndexRequest eventId must be a UUID');
  }
  const key = request.key as Record<string, unknown> | undefined;
  if (
    typeof key !== 'object' ||
    key === null ||
    !isUuid(key.workspaceId) ||
    !isUuid(key.pageId)
  ) {
    throw new Error(
      'IndexRequest key must contain workspaceId and pageId UUIDs',
    );
  }
  if (
    typeof request.inputRevision !== 'string' ||
    !DECIMAL_PATTERN.test(request.inputRevision)
  ) {
    throw new Error('IndexRequest inputRevision must be a decimal string');
  }
  if (!INDEX_OPERATIONS.includes(request.operation as IndexOperation)) {
    throw new Error('IndexRequest operation is invalid');
  }
  if (!INDEX_CAUSES.includes(request.cause as IndexCause)) {
    throw new Error('IndexRequest cause is invalid');
  }
  if (!isIso8601(request.occurredAt)) {
    throw new Error('IndexRequest occurredAt must be ISO8601');
  }
  return {
    schemaVersion: RAG_SCHEMA_VERSION,
    eventId: request.eventId,
    key: { workspaceId: key.workspaceId, pageId: key.pageId },
    inputRevision: request.inputRevision as InputRevision,
    operation: request.operation as IndexOperation,
    cause: request.cause as IndexCause,
    occurredAt: request.occurredAt,
  };
}

/** The queue payload is the exact serialized request; JSON round-trips it losslessly. */
export function serializeIndexRequest(request: IndexRequest): string {
  return JSON.stringify(request);
}
