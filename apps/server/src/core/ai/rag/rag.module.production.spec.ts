import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { CacheModule } from '@nestjs/cache-manager';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { DatabaseModule } from '@docmost/db/database.module';
import { EncryptionModule } from '../../../integrations/encryption/encryption.module';
import { EnvironmentModule } from '../../../integrations/environment/environment.module';
import { QueueName } from '../../../integrations/queue/constants';
import { OutboundModule } from '../../../integrations/outbound/outbound.module';
import { QueueModule } from '../../../integrations/queue/queue.module';
import { StorageModule } from '../../../integrations/storage/storage.module';
import { CaslModule } from '../../casl/casl.module';
import { PageAccessModule } from '../../page/page-access/page-access.module';
import { RAG_EMBEDDING_PORT, RAG_PROFILE_RESOLVER } from './contracts';
import { RAG_PROFILE_CONFIG_VALIDATOR } from './http/rag-profile-validator';
import { RagSettingsService } from './http/rag-settings.service';
import { OpenAiCompatibleEmbeddingAdapter } from './embedding/openai-compatible.embedding.adapter';
import {
  RagComposedProfileResolver,
  RagComposedProfileValidator,
  RagModule,
} from './rag.module';
import { RagRetrieverService } from './retrieval/rag-retriever.service';
import { RagRetrievalModule } from './retrieval/retrieval.module';

// Same pattern as the api-key module spec: the RAG graph reads connection
// configuration from the environment, so the environment module is stubbed
// while every RAG binding stays real. The BullMQ queue is the Redis
// connection and is stubbed accordingly; compile() never connects to it.
jest.mock('../../../integrations/environment/environment.module', () => {
  const { Global, Module } =
    jest.requireActual<typeof import('@nestjs/common')>('@nestjs/common');
  const { EnvironmentService } = jest.requireActual<
    typeof import('../../../integrations/environment/environment.service')
  >('../../../integrations/environment/environment.service');

  @Global()
  class TestEnvironmentModule {}
  Module({
    providers: [
      {
        provide: EnvironmentService,
        useValue: {
          getDatabaseURL: () => 'postgres://localhost/docmost',
          getDatabaseMaxPool: () => 1,
          getNodeEnv: () => 'test',
          getAppSecret: () => 'production-compile-spec-secret-0123456789ab',
          getStorageDriver: () => 'local',
          getRedisUrl: () => 'redis://localhost:6379',
        },
      },
    ],
    exports: [EnvironmentService],
  })(TestEnvironmentModule);

  return { EnvironmentModule: TestEnvironmentModule };
});

jest.mock('../../../database/listeners/page.listener', () => ({
  PageListener: class PageListener {},
}));

// The general queue processor is an unrelated BullMQ worker whose destroy
// hook throws when its worker was never initialized (compile() does not run
// lifecycle init); stubbing it keeps the teardown honest without touching
// any RAG binding.
jest.mock(
  '../../../integrations/queue/processors/general-queue.processor',
  () => ({ GeneralQueueProcessor: class {} }),
);

/**
 * Proves the production Nest graph compiles with the composed RAG module.
 * The HTTP settings writer injects RAG_PROFILE_CONFIG_VALIDATOR and the
 * retrieval component injects RAG_PROFILE_RESOLVER and RAG_EMBEDDING_PORT,
 * so the composed module must expose those tokens to the real consumer
 * modules — no RAG token overrides.
 */
describe('RagModule production wiring', () => {
  it('exposes the composed RAG ports to the HTTP and retrieval consumers', async () => {
    const module = await Test.createTestingModule({
      imports: [
        CacheModule.register({ isGlobal: true }),
        EventEmitterModule.forRoot(),
        ScheduleModule.forRoot(),
        DatabaseModule,
        EncryptionModule,
        OutboundModule,
        QueueModule,
        StorageModule.forRootAsync({ imports: [EnvironmentModule] }),
        CaslModule,
        PageAccessModule,
        RagModule,
        RagRetrievalModule,
      ],
    })
      // The queue is the Redis connection: both the RAG queue the relay
      // publishes to and the general queue processor's worker connection are
      // stubbed so compile() never opens sockets.
      .overrideProvider(getQueueToken(QueueName.RAG_QUEUE))
      .useValue({ add: jest.fn(), close: jest.fn(async () => undefined) })
      .overrideProvider(getQueueToken(QueueName.GENERAL_QUEUE))
      .useValue({ add: jest.fn(), close: jest.fn(async () => undefined) })
      .compile();

    expect(module.get(RAG_PROFILE_CONFIG_VALIDATOR)).toBeInstanceOf(
      RagComposedProfileValidator,
    );
    expect(module.get(RAG_PROFILE_RESOLVER)).toBeInstanceOf(
      RagComposedProfileResolver,
    );
    expect(module.get(RAG_EMBEDDING_PORT)).toBeInstanceOf(
      OpenAiCompatibleEmbeddingAdapter,
    );

    // The accepted unwired consumers receive the composed bindings.
    expect(module.get(RagSettingsService)['profileValidator']).toBe(
      module.get(RAG_PROFILE_CONFIG_VALIDATOR),
    );
    const retriever = module.get(RagRetrieverService);
    expect(retriever['profileResolver']).toBe(module.get(RAG_PROFILE_RESOLVER));
    expect(retriever['embeddingPort']).toBe(module.get(RAG_EMBEDDING_PORT));

    await module.close();
  });
});
