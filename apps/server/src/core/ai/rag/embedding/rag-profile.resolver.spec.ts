import { Workspace } from '@docmost/db/types/entity.types';
import { RagError, IndexProfileConfig } from '../contracts';
import { computeProfileHash } from './profile-hash';
import { RagProfileResolverService } from './rag-profile.resolver';

const validConfig = (): IndexProfileConfig => ({
  parserVersion: 'parser-1',
  chunkerVersion: 'chunker-1',
  maxChunkTokens: 512,
  overlapTokens: 64,
  sourcePolicy: {
    requiredMimeTypes: ['text/plain', 'application/pdf'],
    imageInterpretation: 'disabled',
  },
  embedding: {
    driver: 'openai-compatible',
    endpointIdentity: 'workspace-ai-provider',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    tokenizerId: 'o200k_base',
    maxInputTokens: 8192,
  },
});

const workspaceWith = (rag: unknown): Workspace =>
  ({ id: 'workspace-1', settings: { rag } }) as unknown as Workspace;

const resolverWith = (workspace: Workspace | null) =>
  new RagProfileResolverService({
    findById: jest.fn().mockResolvedValue(workspace),
  } as never);

describe('RagProfileResolverService', () => {
  it('resolves the stored profile config with a pinned profile id and hash', async () => {
    const config = validConfig();
    const resolver = resolverWith(
      workspaceWith({ enabled: true, indexProfileConfig: config }),
    );

    const profile = await resolver.resolve('workspace-1');

    expect(profile).toMatchObject(config);
    expect(profile.profileHash).toBe(computeProfileHash(config));
    expect(profile.profileId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('derives the same profile hash regardless of config key order', () => {
    const config = validConfig();
    const reordered = {
      embedding: {
        maxInputTokens: config.embedding.maxInputTokens,
        tokenizerId: config.embedding.tokenizerId,
        dimensions: config.embedding.dimensions,
        model: config.embedding.model,
        endpointIdentity: config.embedding.endpointIdentity,
        driver: config.embedding.driver,
      },
      sourcePolicy: config.sourcePolicy,
      overlapTokens: config.overlapTokens,
      maxChunkTokens: config.maxChunkTokens,
      chunkerVersion: config.chunkerVersion,
      parserVersion: config.parserVersion,
    } as IndexProfileConfig;

    expect(computeProfileHash(reordered)).toBe(computeProfileHash(config));
  });

  it('changes the profile hash when any computation parameter changes', () => {
    const base = validConfig();
    const variants: IndexProfileConfig[] = [
      { ...base, parserVersion: 'parser-2' },
      { ...base, chunkerVersion: 'chunker-2' },
      { ...base, maxChunkTokens: 256 },
      { ...base, overlapTokens: 0 },
      {
        ...base,
        sourcePolicy: { ...base.sourcePolicy, imageInterpretation: 'required' },
      },
      {
        ...base,
        embedding: { ...base.embedding, model: 'text-embedding-3-large' },
      },
      { ...base, embedding: { ...base.embedding, dimensions: 3072 } },
      { ...base, embedding: { ...base.embedding, tokenizerId: null } },
      {
        ...base,
        embedding: { ...base.embedding, endpointIdentity: 'other-endpoint' },
      },
    ];

    for (const variant of variants) {
      expect(computeProfileHash(variant)).not.toBe(computeProfileHash(base));
    }
  });

  it('fails explicitly when RAG is disabled or not configured', async () => {
    const resolver = resolverWith(
      workspaceWith({ enabled: false, indexProfileConfig: validConfig() }),
    );
    await expect(resolver.resolve('workspace-1')).rejects.toThrow(RagError);
    await expect(resolver.resolve('workspace-1')).rejects.toMatchObject({
      code: 'EMBEDDING_NOT_CONFIGURED',
    });

    const unconfigured = resolverWith(workspaceWith(undefined));
    await expect(unconfigured.resolve('workspace-1')).rejects.toMatchObject({
      code: 'EMBEDDING_NOT_CONFIGURED',
    });
  });

  it('rejects unsupported embedding drivers explicitly', async () => {
    const config = validConfig();
    config.embedding.driver = 'deterministic-hash';
    const resolver = resolverWith(
      workspaceWith({ enabled: true, indexProfileConfig: config }),
    );

    await expect(resolver.resolve('workspace-1')).rejects.toMatchObject({
      code: 'EMBEDDING_NOT_CONFIGURED',
      message: expect.stringContaining('deterministic-hash'),
    });
  });

  it('rejects invalid profile limits and shapes', async () => {
    const cases: Array<() => IndexProfileConfig> = [
      () => ({ ...validConfig(), overlapTokens: 512 }),
      () => ({ ...validConfig(), maxChunkTokens: 0 }),
      () => {
        const config = validConfig();
        config.embedding.dimensions = 0;
        return config;
      },
      () => {
        const config = validConfig();
        config.embedding.maxInputTokens = -1;
        return config;
      },
      () => {
        const config = validConfig();
        config.embedding.model = ' ';
        return config;
      },
      () => {
        const config = validConfig();
        config.embedding.tokenizerId = '';
        return config;
      },
      () => {
        const config = validConfig();
        config.embedding.endpointIdentity = '';
        return config;
      },
      () => {
        const config = validConfig();
        config.sourcePolicy.requiredMimeTypes = ['text/plain', ''];
        return config;
      },
      () => {
        const config = validConfig();
        config.sourcePolicy.imageInterpretation = 'auto' as never;
        return config;
      },
      () => ({ ...validConfig(), parserVersion: '' }),
    ];

    for (const build of cases) {
      const resolver = resolverWith(
        workspaceWith({ enabled: true, indexProfileConfig: build() }),
      );
      await expect(resolver.resolve('workspace-1')).rejects.toMatchObject({
        code: 'EMBEDDING_NOT_CONFIGURED',
      });
    }
  });
});
