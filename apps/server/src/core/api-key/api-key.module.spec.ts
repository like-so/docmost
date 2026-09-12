import { Test } from '@nestjs/testing';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CacheModule } from '@nestjs/cache-manager';
import { ApiKeyRepo } from '@docmost/db/repos/api-key/api-key.repo';
import { DatabaseModule } from '@docmost/db/database.module';

jest.mock('../../integrations/environment/environment.module', () => {
  const { Module } = jest.requireActual<typeof import('@nestjs/common')>(
    '@nestjs/common',
  );
  const { EnvironmentService } = jest.requireActual<
    typeof import('../../integrations/environment/environment.service')
  >('../../integrations/environment/environment.service');

  class TestEnvironmentModule {}
  Module({
    providers: [
      {
        provide: EnvironmentService,
        useValue: {
          getDatabaseURL: () => 'postgres://localhost/docmost',
          getDatabaseMaxPool: () => 1,
          getNodeEnv: () => 'test',
        },
      },
    ],
    exports: [EnvironmentService],
  })(TestEnvironmentModule);

  return { EnvironmentModule: TestEnvironmentModule };
});

jest.mock('../../database/listeners/page.listener', () => ({
  PageListener: class PageListener {},
}));

describe('ApiKeyModule database integration', () => {
  it('resolves the database-owned API key repository', async () => {
    const module = await Test.createTestingModule({
      imports: [
        CacheModule.register({ isGlobal: true }),
        EventEmitterModule.forRoot(),
        DatabaseModule,
      ],
    }).compile();

    expect(module.get(ApiKeyRepo)).toBeInstanceOf(ApiKeyRepo);
    await module.close();
  });
});
