import { randomUUID } from 'node:crypto';
import { Job } from 'bullmq';
import { Kysely } from 'kysely';
import { DbInterface } from '@docmost/db/types/db.interface';
import { Workspace } from '@docmost/db/types/entity.types';
import { EncryptionService } from '../../../integrations/encryption/encryption.service';
import { StorageService } from '../../../integrations/storage/storage.service';
import { SchedulerRegistry } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import {
  ChunkBatch,
  Chunker,
  DocumentParser,
  EmbeddingPort,
  IndexProfileConfig,
  IndexRequest,
  NormalizedDocument,
  RagError,
  RagProfileResolver,
  RAG_SCHEMA_VERSION,
  toInputRevision,
} from './contracts';
import { QueueJob } from '../../../integrations/queue/constants';
import { computeProfileHash, computeProfileId } from './embedding/profile-hash';
import { providerSettingsIdentity } from './embedding/provider-settings';
import { RagComposedProfileValidator } from './rag.module';
import { RagGenerationStore } from './index-store/rag-generation.store';
import { RagOutboxRelayService } from './rag-outbox-relay.service';
import {
  RagIndexerCancelledError,
  RagIndexerService,
} from './rag-indexer.service';
import { RagProcessor } from './rag.processor';
import { RagOutboxRepository } from './persistence/rag-outbox.repository';
import { RagSourceLedger } from './persistence/rag-source-ledger';
import { RagStateRepository } from './persistence/rag-state.repository';
import { RagSourceReader } from './source/rag-source.reader';
import {
  ragTestDbConfigured,
  seedPage,
  seedWorkspace,
  withRagTestDb,
} from './persistence/rag-test-db';

const profileConfig = (): IndexProfileConfig => ({
  parserVersion: 'test-parser@1',
  chunkerVersion: 'test-chunker@1',
  maxChunkTokens: 100,
  overlapTokens: 0,
  sourcePolicy: {
    requiredMimeTypes: ['text/plain'],
    imageInterpretation: 'disabled',
  },
  embedding: {
    driver: 'openai-compatible',
    endpointIdentity: 'test-endpoint',
    model: 'test-model',
    dimensions: 4,
    tokenizerId: 'test-tokenizer',
    maxInputTokens: 512,
  },
});

(ragTestDbConfigured ? describe : describe.skip)(
  'RagIndexer composed worker',
  () => {
    interface Fixture {
      db: Kysely<DbInterface>;
      workspaceId: string;
      pageId: string;
      indexer: RagIndexerService;
      ledger: RagSourceLedger;
      outboxRepository: RagOutboxRepository;
      embedding: { embed: jest.Mock };
      resolver: { resolve: jest.Mock };
      enableProfile: (config?: IndexProfileConfig) => Promise<void>;
      setProfileRow: (values: {
        enabled: boolean;
        profileId: string | null;
        profileHash: string | null;
      }) => Promise<void>;
      recordChange: (
        operation: 'upsert' | 'delete',
        cause?: IndexRequest['cause'],
      ) => Promise<IndexRequest>;
      pageText: (text: string) => Promise<void>;
      insertGeneration: (values: {
        inputRevision: string;
        profileHash: string;
        status: 'staged' | 'failed';
        createdAt?: Date;
        errorCode?: string | null;
      }) => Promise<void>;
      markOutboxDelivered: (deliveredAt: Date) => Promise<void>;
      setGenerationCreatedAt: (
        inputRevision: string,
        createdAt: Date,
      ) => Promise<void>;
      makeRelay: (queue: Queue) => RagOutboxRelayService;
      profileHash: () => string;
    }

    const setup = async (
      run: (fx: Fixture) => Promise<void>,
    ): Promise<void> => {
      await withRagTestDb(async (db) => {
        const workspaceId = randomUUID();
        const pageId = randomUUID();
        await seedWorkspace(db, workspaceId);
        await seedPage(db, workspaceId, pageId);

        const stateRepository = new RagStateRepository(db);
        const generationStore = new RagGenerationStore(db, stateRepository);
        const outboxRepository = new RagOutboxRepository(db);
        const reader = new RagSourceReader(
          stateRepository,
          db,
          {} as StorageService,
        );
        const ledger = new RagSourceLedger(stateRepository, outboxRepository);

        const resolver: { resolve: jest.Mock } = {
          resolve: jest.fn(async () => {
            const config = profileConfig();
            const profileHash = computeProfileHash(config);
            return {
              ...config,
              profileHash,
              profileId: computeProfileId(profileHash),
            };
          }),
        };
        const parser: DocumentParser = {
          normalize: async (snapshot) =>
            ({
              key: snapshot.key,
              inputRevision: snapshot.inputRevision,
              sections: [
                {
                  source: { kind: 'page' as const },
                  headingPath: ['H1'],
                  text: snapshot.bodyText,
                  textHash: 'hash-' + snapshot.inputRevision,
                },
              ],
              diagnostics: [],
            }) satisfies NormalizedDocument,
        };
        const chunker: Chunker = {
          split: async (document, profile) =>
            ({
              key: document.key,
              inputRevision: document.inputRevision,
              profileHash: profile.profileHash,
              chunks: document.sections.map((section, ordinal) => ({
                chunkId: `${document.key.pageId}:${document.inputRevision}:${ordinal}`,
                ordinal,
                text: section.text,
                tokenCount: Math.max(1, section.text.length),
                locator: {
                  pageId: document.key.pageId,
                  headingPath: section.headingPath,
                  start: 0,
                  end: section.text.length,
                  offsetUnit: 'utf16' as const,
                  textHash: section.textHash,
                },
              })),
            }) as ChunkBatch,
        };
        const embedding: { embed: jest.Mock } = {
          embed: jest.fn(async (_workspaceId, profile, inputs) => ({
            profileHash: profile.profileHash,
            dimensions: 4,
            vectors: inputs.map((input: { chunkId: string }) => ({
              chunkId: input.chunkId,
              values: [1, 0, 0, 0],
            })),
          })),
        };

        const indexer = new RagIndexerService(
          resolver as unknown as RagProfileResolver,
          reader,
          parser,
          chunker,
          embedding as unknown as EmbeddingPort,
          generationStore,
          stateRepository,
          db,
        );

        const fx: Fixture = {
          db,
          workspaceId,
          pageId,
          indexer,
          ledger,
          outboxRepository,
          embedding,
          resolver,
          enableProfile: async (config = profileConfig()) => {
            const profileHash = computeProfileHash(config);
            await db.transaction().execute((trx) =>
              stateRepository.updateWorkspaceProfile(trx, workspaceId, {
                enabled: true,
                profileId: computeProfileId(profileHash),
                profileHash,
              }),
            );
          },
          setProfileRow: async ({ enabled, profileId, profileHash }) => {
            await db.transaction().execute((trx) =>
              stateRepository.updateWorkspaceProfile(trx, workspaceId, {
                enabled,
                profileId,
                profileHash,
              }),
            );
          },
          recordChange: async (operation, cause = 'page') =>
            db
              .transaction()
              .execute((trx) =>
                ledger.recordChange(
                  trx,
                  { workspaceId, pageId },
                  operation,
                  cause,
                ),
              ),
          pageText: async (text) => {
            await db
              .updateTable('pages')
              .set({ title: 'Test page', textContent: text })
              .where('id', '=', pageId)
              .execute();
          },
          insertGeneration: async (values) => {
            await db
              .insertInto('ragGenerations')
              .values({
                workspaceId,
                pageId,
                inputRevision: values.inputRevision,
                profileHash: values.profileHash,
                status: values.status,
                errorCode: values.errorCode ?? null,
                ...(values.createdAt
                  ? { createdAt: values.createdAt, updatedAt: values.createdAt }
                  : {}),
              })
              .execute();
          },
          markOutboxDelivered: async (deliveredAt) => {
            await db
              .updateTable('ragOutbox')
              .set({ status: 'delivered', deliveredAt })
              .execute();
          },
          setGenerationCreatedAt: async (inputRevision, createdAt) => {
            await db
              .updateTable('ragGenerations')
              .set({ createdAt, updatedAt: createdAt })
              .where('inputRevision', '=', inputRevision)
              .execute();
          },
          makeRelay: (queue) =>
            new RagOutboxRelayService(
              outboxRepository,
              ledger,
              queue,
              {} as SchedulerRegistry,
              db,
            ),
          profileHash: () => computeProfileHash(profileConfig()),
        };
        await run(fx);
      });
    };

    it('publishes a committed upsert end to end through the real persistence components', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const request = await fx.recordChange('upsert');

        const result = await fx.indexer.handle(request);

        expect(result.state).toBe('ready');
        expect(result.generationId).toBeDefined();
        const state = await fx.db
          .selectFrom('ragSourceState')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .executeTakeFirst();
        expect(state?.publishedInputRevision).toBe(request.inputRevision);
        const generation = await fx.db
          .selectFrom('ragGenerations')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .executeTakeFirst();
        expect(generation?.status).toBe('published');
        const chunk = await fx.db
          .selectFrom('ragChunks')
          .selectAll()
          .where('generationId', '=', generation!.id)
          .executeTakeFirst();
        expect(chunk?.text).toBe('hello world');
        expect(chunk?.embedding).toEqual([1, 0, 0, 0]);
        const pending = await fx.outboxRepository.pending(fx.db, 10);
        expect(pending).toHaveLength(1);
      });
    });

    it('replays a duplicate delivery idempotently', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const request = await fx.recordChange('upsert');

        const first = await fx.indexer.handle(request);
        const second = await fx.indexer.handle(request);

        expect(first.state).toBe('ready');
        expect(second.state).toBe('ready');
        expect(second.generationId).toBe(first.generationId);
        const generations = await fx.db
          .selectFrom('ragGenerations')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .execute();
        expect(generations).toHaveLength(1);
      });
    });

    it('rejects a stale revision without publishing', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const first = await fx.recordChange('upsert');
        const second = await fx.recordChange('upsert');

        const stale = await fx.indexer.handle(first);
        const current = await fx.indexer.handle(second);

        expect(stale.state).toBe('superseded');
        expect(current.state).toBe('ready');
        const state = await fx.db
          .selectFrom('ragSourceState')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .executeTakeFirst();
        expect(state?.publishedInputRevision).toBe(second.inputRevision);
      });
    });

    it('purges on delete and rejects late work after deletion', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const upsert = await fx.recordChange('upsert');
        await fx.indexer.handle(upsert);
        const deletion = await fx.recordChange('delete');

        const deleted = await fx.indexer.handle(deletion);
        // The persisted tombstone rejects late work after deletion.
        const late = await fx.indexer.handle(upsert);

        expect(deleted.state).toBe('deleted');
        expect(late.state).toBe('deleted');
        const generations = await fx.db
          .selectFrom('ragGenerations')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .execute();
        expect(generations).toHaveLength(0);
        const state = await fx.db
          .selectFrom('ragSourceState')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .executeTakeFirst();
        expect(state?.sourceStatus).toBe('deleted');
      });
    });

    it('returns the disabled outcome without resolving a profile or publishing', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.setProfileRow({
          enabled: false,
          profileId: null,
          profileHash: null,
        });
        const request = await fx.recordChange('upsert');

        const result = await fx.indexer.handle(request);

        expect(result.state).toBe('disabled');
        expect(fx.resolver.resolve).not.toHaveBeenCalled();
        const generations = await fx.db
          .selectFrom('ragGenerations')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .execute();
        expect(generations).toHaveLength(0);
      });
    });

    it('persists a durable failed phase on configuration errors and recovers on the relevant correction', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const request = await fx.recordChange('upsert');
        fx.resolver.resolve.mockRejectedValueOnce(
          new RagError('EMBEDDING_NOT_CONFIGURED', 'endpoint missing'),
        );

        const failed = await fx.indexer.handle(request);

        expect(failed.state).toBe('failed');
        const failedRow = await fx.db
          .selectFrom('ragGenerations')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .where('status', '=', 'failed')
          .executeTakeFirst();
        expect(failedRow?.errorCode).toBe('EMBEDDING_NOT_CONFIGURED');

        const recovered = await fx.indexer.handle(request);
        expect(recovered.state).toBe('ready');
      });
    });

    it('leaves transient embedding failures to the bounded retry policy without a failed row', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const request = await fx.recordChange('upsert');
        fx.embedding.embed.mockRejectedValueOnce(
          new RagError('EMBEDDING_UNAVAILABLE', 'provider timeout'),
        );

        await expect(fx.indexer.handle(request)).rejects.toMatchObject({
          code: 'EMBEDDING_UNAVAILABLE',
        });
        const failedRows = await fx.db
          .selectFrom('ragGenerations')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .where('status', '=', 'failed')
          .execute();
        expect(failedRows).toHaveLength(0);

        const retried = await fx.indexer.handle(request);
        expect(retried.state).toBe('ready');
      });
    });

    it('blocks ready when a required source is unsupported and recovers after correction', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const request = await fx.recordChange('upsert');
        const parser = (fx.indexer as unknown as { parser: DocumentParser })
          .parser;
        const originalNormalize = parser.normalize.bind(parser);
        jest
          .spyOn(parser, 'normalize')
          .mockImplementation(async (snapshot, profile) => {
            const document = await originalNormalize(snapshot, profile);
            return {
              ...document,
              diagnostics: [
                ...document.diagnostics,
                {
                  sourceId: 'attachment-1',
                  code: 'SOURCE_UNSUPPORTED' as const,
                },
              ],
            };
          });

        const failed = await fx.indexer.handle(request);

        expect(failed.state).toBe('failed');
        const failedRow = await fx.db
          .selectFrom('ragGenerations')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .where('status', '=', 'failed')
          .executeTakeFirst();
        expect(failedRow?.errorCode).toBe('SOURCE_UNSUPPORTED');

        jest.restoreAllMocks();
        const recovered = await fx.indexer.handle(request);
        expect(recovered.state).toBe('ready');
      });
    });

    it('cancellation writes no terminal state and a redelivery completes', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const request = await fx.recordChange('upsert');
        const controller = new AbortController();
        controller.abort();

        await expect(
          fx.indexer.handle(request, { signal: controller.signal }),
        ).rejects.toBeInstanceOf(RagIndexerCancelledError);
        const generations = await fx.db
          .selectFrom('ragGenerations')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .execute();
        expect(generations).toHaveLength(0);

        const redelivered = await fx.indexer.handle(request);
        expect(redelivered.state).toBe('ready');
      });
    });

    it('rejects a profile hash mismatch at publication instead of mixing embeddings', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const request = await fx.recordChange('upsert');
        // The workspace profile changes after the worker resolved the old hash.
        const drifted = profileConfig();
        drifted.embedding.model = 'other-model';
        const driftedHash = computeProfileHash(drifted);
        await fx.db
          .updateTable('ragWorkspaceProfile')
          .set({
            profileId: computeProfileId(driftedHash),
            profileHash: driftedHash,
          })
          .where('workspaceId', '=', fx.workspaceId)
          .execute();

        const result = await fx.indexer.handle(request);

        expect(result.state).toBe('superseded');
        const state = await fx.db
          .selectFrom('ragSourceState')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .executeTakeFirst();
        expect(state?.publishedInputRevision).toBeNull();
      });
    });

    it('delivers pending outbox rows only after an accepted enqueue', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const request = await fx.recordChange('upsert');
        const queue = { add: jest.fn() } as unknown as Queue;
        const relay = new RagOutboxRelayService(
          fx.outboxRepository,
          fx.ledger,
          queue,
          {} as SchedulerRegistry,
          fx.db,
        );

        await relay.reconcile();

        expect(queue.add).toHaveBeenCalledWith(
          QueueJob.RAG_INDEX_REQUEST,
          JSON.stringify(request),
          expect.objectContaining({ jobId: request.eventId, attempts: 3 }),
        );
        const delivered = await fx.db
          .selectFrom('ragOutbox')
          .selectAll()
          .where('id', '=', request.eventId)
          .executeTakeFirst();
        expect(delivered?.status).toBe('delivered');
      });
    });

    it('keeps uncertain enqueues pending with a redacted error code', async () => {
      await setup(async (fx) => {
        await fx.enableProfile();
        await fx.recordChange('upsert');
        const queue = {
          add: jest.fn().mockRejectedValue(new Error('redis down')),
        } as unknown as Queue;
        const relay = new RagOutboxRelayService(
          fx.outboxRepository,
          fx.ledger,
          queue,
          {} as SchedulerRegistry,
          fx.db,
        );

        await relay.reconcile();

        const row = await fx.db
          .selectFrom('ragOutbox')
          .selectAll()
          .executeTakeFirst();
        expect(row?.status).toBe('pending');
        expect(row?.attempts).toBe(1);
        expect(row?.lastErrorCode).toBe('ENQUEUE_FAILED');
      });
    });

    it('reschedules stalled enabled pages with a profile cause and skips disabled workspaces', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        // Enabled workspace: a live page with a desired revision, no outbox row
        // and no staged/failed work is a lost delivery.
        await fx.enableProfile();
        await fx.db
          .insertInto('ragSourceState')
          .values({
            workspaceId: fx.workspaceId,
            pageId: fx.pageId,
            desiredInputRevision: '1',
            sourceStatus: 'live',
          })
          .execute();
        const queue = {
          add: jest.fn(async () => undefined),
        } as unknown as Queue;
        const relay = new RagOutboxRelayService(
          fx.outboxRepository,
          fx.ledger,
          queue,
          {} as SchedulerRegistry,
          fx.db,
        );

        await relay.reconcile();

        const rows = await fx.db
          .selectFrom('ragOutbox')
          .selectAll()
          .where('cause', '=', 'profile')
          .execute();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.pageId).toBe(fx.pageId);

        // Disabled workspace: no rescheduling churn.
        await fx.setProfileRow({
          enabled: false,
          profileId: null,
          profileHash: null,
        });
        await fx.db
          .deleteFrom('ragOutbox')
          .where('cause', '=', 'profile')
          .execute();
        await relay.reconcile();
        const after = await fx.db
          .selectFrom('ragOutbox')
          .selectAll()
          .where('cause', '=', 'profile')
          .execute();
        expect(after).toHaveLength(0);
      });
    });

    it('schedules a paginated profile reindex when the published hash no longer matches', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const request = await fx.recordChange('upsert');
        await fx.indexer.handle(request);
        const drifted = profileConfig();
        drifted.embedding.model = 'other-model';
        const driftedHash = computeProfileHash(drifted);
        await fx.db
          .updateTable('ragWorkspaceProfile')
          .set({
            profileId: computeProfileId(driftedHash),
            profileHash: driftedHash,
          })
          .where('workspaceId', '=', fx.workspaceId)
          .execute();
        const queue = {
          add: jest.fn(async () => undefined),
        } as unknown as Queue;
        const relay = new RagOutboxRelayService(
          fx.outboxRepository,
          fx.ledger,
          queue,
          {} as SchedulerRegistry,
          fx.db,
        );

        await relay.reconcile();

        const rows = await fx.db
          .selectFrom('ragOutbox')
          .selectAll()
          .where('cause', '=', 'profile')
          .execute();
        expect(rows.map((row) => row.pageId)).toContain(fx.pageId);
        expect(rows.every((row) => row.operation === 'upsert')).toBe(true);
      });
    });

    it('records one profile reindex per profile generation across repeated and concurrent sweeps', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const request = await fx.recordChange('upsert');
        await fx.indexer.handle(request);
        // The profile changes and the original delivery is long past, so the
        // page is eligible and the dedup must carry the scheduling alone.
        const drifted = profileConfig();
        drifted.embedding.model = 'other-model';
        const driftedHash = computeProfileHash(drifted);
        await fx.db
          .updateTable('ragWorkspaceProfile')
          .set({
            profileId: computeProfileId(driftedHash),
            profileHash: driftedHash,
          })
          .where('workspaceId', '=', fx.workspaceId)
          .execute();
        await fx.markOutboxDelivered(new Date(Date.now() - 60 * 60 * 1000));
        const state = () =>
          fx.db
            .selectFrom('ragSourceState')
            .selectAll()
            .where('pageId', '=', fx.pageId)
            .executeTakeFirst();

        const relayA = fx.makeRelay({
          add: jest.fn(async () => undefined),
        } as unknown as Queue);
        const relayB = fx.makeRelay({
          add: jest.fn(async () => undefined),
        } as unknown as Queue);
        await Promise.all([relayA.reconcile(), relayB.reconcile()]);

        const profileEvents = await fx.db
          .selectFrom('ragOutbox')
          .selectAll()
          .where('cause', '=', 'profile')
          .execute();
        expect(profileEvents).toHaveLength(1);
        expect((await state())?.desiredInputRevision).toBe('2');

        // Repeated sweeps while the current delivery is live stay deduped.
        await relayA.reconcile();
        await relayB.reconcile();
        const after = await fx.db
          .selectFrom('ragOutbox')
          .selectAll()
          .where('cause', '=', 'profile')
          .execute();
        expect(after).toHaveLength(1);
        expect((await state())?.desiredInputRevision).toBe('2');
      });
    });

    it('does not supersede slow staged work at the current profile but recovers it after the grace window', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        await fx.recordChange('upsert');
        await fx.insertGeneration({
          inputRevision: '1',
          profileHash: fx.profileHash(),
          status: 'staged',
          createdAt: new Date(),
        });
        await fx.markOutboxDelivered(new Date(Date.now() - 60 * 60 * 1000));
        const relay = fx.makeRelay({
          add: jest.fn(async () => undefined),
        } as unknown as Queue);

        await relay.reconcile();
        expect(
          await fx.db.selectFrom('ragOutbox').selectAll().execute(),
        ).toHaveLength(0);

        // After the grace window the staged work is abandoned: recover it.
        await fx.setGenerationCreatedAt(
          '1',
          new Date(Date.now() - 60 * 60 * 1000),
        );
        await relay.reconcile();
        const rows = await fx.db.selectFrom('ragOutbox').selectAll().execute();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.cause).toBe('profile');
      });
    });

    it('keeps a durable first-generation failure terminal until the profile row advances', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        await fx.recordChange('upsert');
        await fx.insertGeneration({
          inputRevision: '1',
          profileHash: fx.profileHash(),
          status: 'failed',
          errorCode: 'SOURCE_UNSUPPORTED',
          createdAt: new Date(),
        });
        await fx.markOutboxDelivered(new Date(Date.now() - 60 * 60 * 1000));
        const relay = fx.makeRelay({
          add: jest.fn(async () => undefined),
        } as unknown as Queue);

        await relay.reconcile();
        expect(
          await fx.db.selectFrom('ragOutbox').selectAll().execute(),
        ).toHaveLength(0);

        // A settings save re-persists the same profile and advances the
        // profile row's updated_at, releasing the page for recovery.
        await fx.enableProfile();
        await relay.reconcile();
        const rows = await fx.db.selectFrom('ragOutbox').selectAll().execute();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.cause).toBe('profile');
      });
    });

    it('recovers abandoned staged work after disable and re-enable', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        await fx.recordChange('upsert');
        await fx.insertGeneration({
          inputRevision: '1',
          profileHash: fx.profileHash(),
          status: 'staged',
          createdAt: new Date(),
        });
        await fx.markOutboxDelivered(new Date(Date.now() - 60 * 60 * 1000));

        // Disable then re-enable: the profile row advances past the staged
        // work, which is no longer the active generation for this target.
        await fx.setProfileRow({
          enabled: false,
          profileId: null,
          profileHash: null,
        });
        await fx.enableProfile();
        const relay = fx.makeRelay({
          add: jest.fn(async () => undefined),
        } as unknown as Queue);

        await relay.reconcile();
        const rows = await fx.db.selectFrom('ragOutbox').selectAll().execute();
        expect(rows).toHaveLength(1);
        expect(rows[0]?.cause).toBe('profile');
      });
    });

    it('dispatches only RAG index requests through the shared AI queue processor', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const request = await fx.recordChange('upsert');
        const handle = jest.spyOn(fx.indexer, 'handle');
        const processor = new RagProcessor(fx.indexer);

        await processor.process({
          name: 'search-index-page',
          data: '{}',
          attemptsMade: 1,
          opts: { attempts: 3 },
        } as unknown as Job<string>);
        expect(handle).not.toHaveBeenCalled();

        await processor.process({
          name: QueueJob.RAG_INDEX_REQUEST,
          data: JSON.stringify(request),
          attemptsMade: 1,
          opts: { attempts: 3 },
        } as unknown as Job<string>);
        expect(handle).toHaveBeenCalledWith(request);

        handle.mockRestore();
      });
    });

    it('persists the durable failed phase on the final bounded retry only', async () => {
      await setup(async (fx) => {
        await fx.pageText('hello world');
        await fx.enableProfile();
        const request = await fx.recordChange('upsert');
        fx.embedding.embed.mockRejectedValue(
          new RagError('EMBEDDING_UNAVAILABLE', 'provider down'),
        );
        const processor = new RagProcessor(fx.indexer);
        const processJob = (attemptsMade: number) =>
          processor.process({
            name: QueueJob.RAG_INDEX_REQUEST,
            data: JSON.stringify(request),
            attemptsMade,
            opts: { attempts: 3 },
          } as unknown as Job<string>);

        // attemptsMade is zero-based: with 3 attempts the final attempt is 2,
        // so an intermediate attempt must not write a terminal phase.
        await expect(processJob(1)).rejects.toBeInstanceOf(RagError);
        const intermediate = await fx.db
          .selectFrom('ragGenerations')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .where('status', '=', 'failed')
          .execute();
        expect(intermediate).toHaveLength(0);

        await expect(processJob(2)).rejects.toBeInstanceOf(RagError);

        const failedRow = await fx.db
          .selectFrom('ragGenerations')
          .selectAll()
          .where('pageId', '=', fx.pageId)
          .where('status', '=', 'failed')
          .executeTakeFirst();
        expect(failedRow?.errorCode).toBe('EMBEDDING_UNAVAILABLE');
      });
    });

    it('round-trips the serialized queue payload through parseIndexRequest', async () => {
      await setup(async (fx) => {
        const request = await fx.recordChange('upsert');
        const parsed = JSON.parse(JSON.stringify(request)) as IndexRequest;
        expect(parsed).toEqual({
          schemaVersion: RAG_SCHEMA_VERSION,
          eventId: request.eventId,
          key: { workspaceId: fx.workspaceId, pageId: fx.pageId },
          inputRevision: toInputRevision(request.inputRevision),
          operation: 'upsert',
          cause: 'page',
          occurredAt: request.occurredAt,
        });
      });
    });
  },
);

describe('RagComposedProfileValidator', () => {
  const providerSettings = {
    driver: 'openai-compatible',
    baseUrl: 'https://embedding.example.com/v1',
    chatModel: 'chat-test',
    embeddingModel: 'text-embedding-test',
  };
  const workspaceWithProvider = () =>
    ({
      settings: { ai: { providerSecret: JSON.stringify(providerSettings) } },
    }) as unknown as Workspace;
  const validator = new RagComposedProfileValidator({
    decrypt: (secret: string) => secret,
  } as unknown as EncryptionService);

  it('derives endpointIdentity from the workspace provider settings and ignores client input', () => {
    const profile = validator.validate(
      workspaceWithProvider(),
      profileConfig(),
    );

    expect(profile.embedding.endpointIdentity).toBe(
      providerSettingsIdentity(providerSettings),
    );
    // The hash is computed over the normalized config, so the persisted
    // stored config re-hashes to the same profile identity.
    expect(
      computeProfileHash({
        ...profileConfig(),
        embedding: {
          ...profileConfig().embedding,
          endpointIdentity: profile.embedding.endpointIdentity,
        },
      }),
    ).toBe(profile.profileHash);
  });

  it('requires workspace AI provider settings', () => {
    expect(() => validator.validate({} as Workspace, profileConfig())).toThrow(
      RagError,
    );
  });
});
