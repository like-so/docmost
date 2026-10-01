import * as undici from 'undici';
import { createServer, type Server } from 'node:http';
import { Workspace } from '@docmost/db/types/entity.types';
import { EncryptionService } from '../../../../integrations/encryption/encryption.service';
import { EnvironmentService } from '../../../../integrations/environment/environment.service';
import { OutboundAgentFactory } from '../../../../integrations/outbound/outbound-agent.factory';
import { OutboundUrlGuard } from '../../../../integrations/outbound/outbound-url.guard';
import { EmbeddingInput, IndexProfile, RagError } from '../contracts';
import { OpenAiCompatibleEmbeddingAdapter } from './openai-compatible.embedding.adapter';
import { providerSettingsIdentity } from './provider-settings';

// Captured before any test can spy on `undici.request`: later spies replace
// the module export, so a lazy lookup inside a test would observe the mock.
const realUndiciRequest = jest.requireActual('undici')
  .request as typeof undici.request;

const API_KEY = 'sk-test-secret-value';

const PROVIDER_FIXTURE = {
  driver: 'openai-compatible',
  baseUrl: 'https://embeddings.example.com/v1',
  chatModel: 'chat-model',
  apiKey: API_KEY,
};

const profile = (
  overrides?: Partial<IndexProfile['embedding']>,
): IndexProfile =>
  ({
    profileId: '0b6aa2a9-1d55-5c96-9a29-60f24e3d5f21',
    profileHash: 'profile-hash-1',
    parserVersion: 'parser-1',
    chunkerVersion: 'chunker-1',
    maxChunkTokens: 512,
    overlapTokens: 64,
    sourcePolicy: {
      requiredMimeTypes: ['text/plain'],
      imageInterpretation: 'disabled',
    },
    embedding: {
      driver: 'openai-compatible',
      endpointIdentity: providerSettingsIdentity(PROVIDER_FIXTURE),
      model: 'text-embedding-3-small',
      dimensions: 4,
      tokenizerId: 'o200k_base',
      maxInputTokens: 8192,
      ...overrides,
    },
  }) as IndexProfile;

const inputs = (count: number): EmbeddingInput[] =>
  Array.from({ length: count }, (_, index) => ({
    chunkId: `chunk-${index}`,
    text: `text ${index}`,
  }));

const providerWorkspace = () =>
  ({
    id: 'workspace-1',
    settings: {
      ai: { providerSecret: 'encrypted-provider-secret' },
    },
  }) as unknown as Workspace;

const buildAdapter = (
  workspace: Workspace | null,
  options?: { decrypted?: unknown; lease?: () => Promise<unknown> },
) => {
  const encryption = {
    decrypt: jest
      .fn()
      .mockReturnValue(JSON.stringify(options?.decrypted ?? PROVIDER_FIXTURE)),
  } as unknown as EncryptionService;
  const outboundAgent = options?.lease
    ? ({ lease: options.lease } as unknown as OutboundAgentFactory)
    : ({
        lease: jest.fn().mockResolvedValue({
          dispatcher: { mocked: true },
          release: jest.fn().mockResolvedValue(undefined),
        }),
      } as unknown as OutboundAgentFactory);
  const environment = {
    getAiRequestTimeoutMs: jest.fn().mockReturnValue(5000),
  } as unknown as EnvironmentService;
  const adapter = new OpenAiCompatibleEmbeddingAdapter(
    { findById: jest.fn().mockResolvedValue(workspace) } as never,
    encryption,
    outboundAgent,
    environment,
  );
  return { adapter, outboundAgent };
};

const okResponse = (data: unknown, model: unknown = 'text-embedding-3-small') =>
  ({
    statusCode: 200,
    body: {
      json: jest.fn().mockResolvedValue({ data, model }),
      destroy: jest.fn(),
    },
  }) as unknown as Awaited<ReturnType<typeof undici.request>>;

const vector = (values: number[], index = 0) => ({ index, embedding: values });

beforeEach(() => {
  jest.spyOn(undici, 'request').mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('OpenAiCompatibleEmbeddingAdapter', () => {
  it('maps response entries by index and echoes the profile hash', async () => {
    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(
        okResponse([
          vector([0.1, 0.2, 0.3, 0.4], 0),
          vector([0.4, 0.3, 0.2, 0.1], 1),
        ]),
      );
    const { adapter } = buildAdapter(providerWorkspace());

    const result = await adapter.embed('workspace-1', profile(), inputs(2));

    expect(result.profileHash).toBe('profile-hash-1');
    expect(result.dimensions).toBe(4);
    expect(result.vectors).toEqual([
      { chunkId: 'chunk-0', values: [0.1, 0.2, 0.3, 0.4] },
      { chunkId: 'chunk-1', values: [0.4, 0.3, 0.2, 0.1] },
    ]);
  });

  it('maps out-of-order responses by their declared index', async () => {
    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(
        okResponse([
          vector([0.4, 0.3, 0.2, 0.1], 1),
          vector([0.1, 0.2, 0.3, 0.4], 0),
        ]),
      );
    const { adapter } = buildAdapter(providerWorkspace());

    const result = await adapter.embed('workspace-1', profile(), inputs(2));

    expect(result.vectors.map((entry) => entry.chunkId)).toEqual([
      'chunk-0',
      'chunk-1',
    ]);
    expect(result.vectors[0].values).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('sends the profile embedding model and keeps credentials in headers only', async () => {
    const requestMock = jest
      .spyOn(undici, 'request')
      .mockResolvedValue(okResponse([vector([1, 0, 0, 0])]));
    const { adapter, outboundAgent } = buildAdapter(providerWorkspace());

    await adapter.embed('workspace-1', profile(), inputs(1));

    const [url, options] = requestMock.mock.calls[0];
    expect(String(url)).toBe('https://embeddings.example.com/v1/embeddings');
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'text-embedding-3-small',
      input: ['text 0'],
    });
    expect((options.headers as Record<string, string>).authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(String(options.body)).not.toContain(API_KEY);
    expect(options.dispatcher).toEqual({ mocked: true });
    expect(outboundAgent.lease).toHaveBeenCalledWith(
      'https://embeddings.example.com/v1/embeddings',
    );
  });

  it('rejects a provider whose endpoint identity drifted from the index profile', async () => {
    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(okResponse([vector([1, 0, 0, 0])]));
    const { adapter } = buildAdapter(providerWorkspace(), {
      decrypted: {
        ...PROVIDER_FIXTURE,
        baseUrl: 'https://other-endpoint.example.com/v1',
      },
    });

    await expect(
      adapter.embed('workspace-1', profile(), inputs(1)),
    ).rejects.toMatchObject({
      code: 'EMBEDDING_NOT_CONFIGURED',
      message: expect.stringContaining('no longer matches the index profile'),
    });
    expect(undici.request).not.toHaveBeenCalled();
  });

  it('rejects a provider whose driver drifted from the index profile', async () => {
    const { adapter } = buildAdapter(providerWorkspace(), {
      decrypted: { ...PROVIDER_FIXTURE, driver: 'gemini' },
    });

    await expect(
      adapter.embed('workspace-1', profile(), inputs(1)),
    ).rejects.toMatchObject({
      code: 'EMBEDDING_NOT_CONFIGURED',
      message: expect.stringContaining('driver no longer matches'),
    });
    expect(undici.request).not.toHaveBeenCalled();
  });

  it('rejects response cardinality mismatches and incomplete order', async () => {
    const { adapter } = buildAdapter(providerWorkspace());
    const profileValue = profile();

    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(okResponse([vector([1, 0, 0, 0])]));
    await expect(
      adapter.embed('workspace-1', profileValue, inputs(2)),
    ).rejects.toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' });

    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(
        okResponse([{ embedding: [1, 0, 0, 0] }, vector([0, 1, 0, 0])]),
      );
    await expect(
      adapter.embed('workspace-1', profileValue, inputs(2)),
    ).rejects.toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' });

    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(
        okResponse([
          vector([1, 0, 0, 0]),
          vector([0, 1, 0, 0]),
          vector([0, 0, 1, 0]),
        ]),
      );
    await expect(
      adapter.embed('workspace-1', profileValue, inputs(2)),
    ).rejects.toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' });
  });

  it('rejects vectors that are not finite, not the profile dimensions or all zeros', async () => {
    const { adapter } = buildAdapter(providerWorkspace());
    const profileValue = profile();

    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(okResponse([vector([1, 0, 0])]));
    await expect(
      adapter.embed('workspace-1', profileValue, inputs(1)),
    ).rejects.toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' });

    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(okResponse([vector([1, 0, 0, Number.NaN])]));
    await expect(
      adapter.embed('workspace-1', profileValue, inputs(1)),
    ).rejects.toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' });

    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(okResponse([vector([0, 0, 0, 0])]));
    await expect(
      adapter.embed('workspace-1', profileValue, inputs(1)),
    ).rejects.toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' });
  });

  it('rejects responses from a different embedding model', async () => {
    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(okResponse([vector([1, 0, 0, 0])], 'other-model'));
    const { adapter } = buildAdapter(providerWorkspace());

    await expect(
      adapter.embed('workspace-1', profile(), inputs(1)),
    ).rejects.toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' });
  });

  it('returns empty vectors without an endpoint call for empty batches', async () => {
    const requestMock = jest.spyOn(undici, 'request');
    const { adapter } = buildAdapter(providerWorkspace());

    const result = await adapter.embed('workspace-1', profile(), []);

    expect(result).toEqual({
      profileHash: 'profile-hash-1',
      dimensions: 4,
      vectors: [],
    });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('embeds a query into a single vector', async () => {
    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(okResponse([vector([0.5, 0.5, 0, 0.5])]));
    const { adapter } = buildAdapter(providerWorkspace());

    const result = await adapter.embedQuery(
      'workspace-1',
      profile(),
      'how do I reset my password?',
    );

    expect(result).toEqual({
      profileHash: 'profile-hash-1',
      dimensions: 4,
      values: [0.5, 0.5, 0, 0.5],
    });
  });

  it('classifies HTTP statuses without leaking request details', async () => {
    const { adapter } = buildAdapter(providerWorkspace());
    const profileValue = profile();

    for (const [status, expected] of [
      [401, 'EMBEDDING_NOT_CONFIGURED'],
      [403, 'EMBEDDING_NOT_CONFIGURED'],
      [404, 'EMBEDDING_NOT_CONFIGURED'],
      [408, 'EMBEDDING_UNAVAILABLE'],
      [429, 'EMBEDDING_UNAVAILABLE'],
      [500, 'EMBEDDING_UNAVAILABLE'],
      [400, 'EMBEDDING_RESPONSE_INVALID'],
    ] as const) {
      jest.spyOn(undici, 'request').mockResolvedValue({
        statusCode: status,
        body: { destroy: jest.fn() },
      } as never);
      const error: RagError = await adapter
        .embed('workspace-1', profileValue, inputs(1))
        .then(
          () => {
            throw new Error(`expected HTTP ${status} to be rejected`);
          },
          (thrown: RagError) => thrown,
        );
      expect(error).toBeInstanceOf(RagError);
      expect(error.code).toBe(expected);
      expect(error.message).not.toContain(API_KEY);
    }
  });

  it('classifies network and cancellation failures as unavailable', async () => {
    const { adapter } = buildAdapter(providerWorkspace());
    const profileValue = profile();

    const refused = Object.assign(new Error('connect refused'), {
      code: 'ECONNREFUSED',
    });
    jest.spyOn(undici, 'request').mockRejectedValue(refused);
    await expect(
      adapter.embed('workspace-1', profileValue, inputs(1)),
    ).rejects.toMatchObject({ code: 'EMBEDDING_UNAVAILABLE' });

    const timeout = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    jest.spyOn(undici, 'request').mockRejectedValue(timeout);
    await expect(
      adapter.embed('workspace-1', profileValue, inputs(1)),
    ).rejects.toMatchObject({ code: 'EMBEDDING_UNAVAILABLE' });
  });

  it('classifies DNS failures during dispatch as unavailable', async () => {
    const { adapter } = buildAdapter(providerWorkspace());
    const dnsFailure = Object.assign(new Error('getaddrinfo ENOTFOUND'), {
      code: 'ENOTFOUND',
    });
    jest.spyOn(undici, 'request').mockRejectedValue(dnsFailure);

    await expect(
      adapter.embed('workspace-1', profile(), inputs(1)),
    ).rejects.toMatchObject({ code: 'EMBEDDING_UNAVAILABLE' });
  });

  it('classifies body transport failures as unavailable and malformed JSON as invalid', async () => {
    const { adapter } = buildAdapter(providerWorkspace());
    const profileValue = profile();

    const aborted = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
    jest.spyOn(undici, 'request').mockResolvedValue({
      statusCode: 200,
      body: { json: jest.fn().mockRejectedValue(aborted), destroy: jest.fn() },
    } as never);
    await expect(
      adapter.embed('workspace-1', profileValue, inputs(1)),
    ).rejects.toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
      message: expect.stringContaining('body failed before completion'),
    });

    jest.spyOn(undici, 'request').mockResolvedValue({
      statusCode: 200,
      body: {
        json: jest.fn().mockRejectedValue(new SyntaxError('Unexpected token')),
        destroy: jest.fn(),
      },
    } as never);
    await expect(
      adapter.embed('workspace-1', profileValue, inputs(1)),
    ).rejects.toMatchObject({ code: 'EMBEDDING_RESPONSE_INVALID' });
  });

  it('rejects a null JSON response body with a typed error', async () => {
    jest.spyOn(undici, 'request').mockResolvedValue({
      statusCode: 200,
      body: { json: jest.fn().mockResolvedValue(null), destroy: jest.fn() },
    } as never);
    const { adapter } = buildAdapter(providerWorkspace());

    await expect(
      adapter.embed('workspace-1', profile(), inputs(1)),
    ).rejects.toMatchObject({
      code: 'EMBEDDING_RESPONSE_INVALID',
      message: expect.stringContaining('invalid response body'),
    });
  });

  it('fails explicitly when the driver or provider settings are missing', async () => {
    const noProvider = buildAdapter(null).adapter;
    await expect(
      noProvider.embed('workspace-1', profile(), inputs(1)),
    ).rejects.toMatchObject({ code: 'EMBEDDING_NOT_CONFIGURED' });

    const requestMock = jest.spyOn(undici, 'request');
    const { adapter } = buildAdapter(providerWorkspace());
    const hashDriver = profile({ driver: 'deterministic-hash' });
    await expect(
      adapter.embed('workspace-1', hashDriver, inputs(1)),
    ).rejects.toMatchObject({ code: 'EMBEDDING_NOT_CONFIGURED' });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('rejects malformed decrypted provider settings with a typed error', async () => {
    const { adapter } = buildAdapter(providerWorkspace(), {
      decrypted: { baseUrl: 'https://embeddings.example.com' },
    });

    await expect(
      adapter.embed('workspace-1', profile(), inputs(1)),
    ).rejects.toMatchObject({
      code: 'EMBEDDING_NOT_CONFIGURED',
      message: expect.stringContaining('unreadable'),
    });
    expect(undici.request).not.toHaveBeenCalled();
  });

  it('classifies lease acquisition failures as unavailable', async () => {
    const { adapter } = buildAdapter(providerWorkspace(), {
      lease: jest
        .fn()
        .mockRejectedValue(new Error('guard rejected private host')),
    });

    await expect(
      adapter.embed('workspace-1', profile(), inputs(1)),
    ).rejects.toMatchObject({
      code: 'EMBEDDING_UNAVAILABLE',
      message: expect.stringContaining('before dispatch'),
    });
  });

  it('consumes and discards the response body before releasing a real lease', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'text-embedding-3-small',
          data: [vector([1, 0, 0, 0], 0)],
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const guard = {
        validate: jest
          .fn()
          .mockResolvedValue({ address: '127.0.0.1', family: 4 }),
      } as unknown as OutboundUrlGuard;
      const factory = new OutboundAgentFactory(guard);
      const localProvider = { ...PROVIDER_FIXTURE, baseUrl };
      const events: string[] = [];
      const realLease = factory.lease.bind(factory);
      jest.spyOn(factory, 'lease').mockImplementation(async (url: string) => {
        const lease = await realLease(url);
        return {
          dispatcher: lease.dispatcher,
          release: async () => {
            events.push('release-start');
            await lease.release();
            events.push('release-end');
          },
        };
      });

      const actualUndici = jest.requireActual('undici') as typeof undici;
      const realRequest = realUndiciRequest.bind(actualUndici);
      jest
        .spyOn(undici, 'request')
        .mockImplementation(
          async (
            url: Parameters<typeof realRequest>[0],
            options: Parameters<typeof realRequest>[1],
          ) => {
            const response = await realRequest(url, options);
            const origJson = response.body.json.bind(response.body);
            const origDestroy = response.body.destroy.bind(response.body);
            response.body.json = async () => {
              events.push('body-read');
              const result = await origJson();
              events.push('body-read-done');
              return result;
            };
            response.body.destroy = () => {
              events.push('body-destroy');
              origDestroy();
            };
            return response;
          },
        );

      const adapter = new OpenAiCompatibleEmbeddingAdapter(
        { findById: jest.fn().mockResolvedValue(providerWorkspace()) } as never,
        {
          decrypt: jest.fn().mockReturnValue(JSON.stringify(localProvider)),
        } as unknown as EncryptionService,
        factory,
        { getAiRequestTimeoutMs: () => 5000 } as unknown as EnvironmentService,
      );

      const result = await adapter.embed(
        'workspace-1',
        profile({ endpointIdentity: providerSettingsIdentity(localProvider) }),
        inputs(1),
      );

      expect(result.vectors).toEqual([
        { chunkId: 'chunk-0', values: [1, 0, 0, 0] },
      ]);
      // undici's BodyReadable.json() destroys the stream as part of normal
      // consumption, so the exact destroy count is an implementation detail.
      // The regression property is: the body is fully read and destroyed
      // strictly before the lease release begins.
      const releaseStart = events.indexOf('release-start');
      expect(releaseStart).toBeGreaterThan(-1);
      expect(events.indexOf('body-read')).toBeGreaterThan(-1);
      expect(events.indexOf('body-read')).toBeLessThan(
        events.indexOf('body-read-done'),
      );
      expect(events.indexOf('body-read-done')).toBeLessThan(releaseStart);
      expect(events.slice(0, releaseStart)).toContain('body-destroy');
      expect(events[events.length - 1]).toBe('release-end');
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('aborts a stalled response body as unavailable and still releases the lease', async () => {
    jest.restoreAllMocks();
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"data":');
      // Intentionally never ends the response: backpressure regression.
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const port = (server.address() as { port: number }).port;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      const guard = {
        validate: jest
          .fn()
          .mockResolvedValue({ address: '127.0.0.1', family: 4 }),
      } as unknown as OutboundUrlGuard;
      const factory = new OutboundAgentFactory(guard);
      const localProvider = { ...PROVIDER_FIXTURE, baseUrl };
      const events: string[] = [];
      const realLease = factory.lease.bind(factory);
      jest.spyOn(factory, 'lease').mockImplementation(async (url: string) => {
        const lease = await realLease(url);
        return {
          dispatcher: lease.dispatcher,
          release: async () => {
            events.push('release-start');
            await lease.release();
            events.push('release-end');
          },
        };
      });

      const adapter = new OpenAiCompatibleEmbeddingAdapter(
        { findById: jest.fn().mockResolvedValue(providerWorkspace()) } as never,
        {
          decrypt: jest.fn().mockReturnValue(JSON.stringify(localProvider)),
        } as unknown as EncryptionService,
        factory,
        { getAiRequestTimeoutMs: () => 400 } as unknown as EnvironmentService,
      );

      const error: RagError = await adapter
        .embed(
          'workspace-1',
          profile({
            endpointIdentity: providerSettingsIdentity(localProvider),
          }),
          inputs(1),
        )
        .then(
          () => {
            throw new Error('expected the stalled body to be rejected');
          },
          (thrown: RagError) => thrown,
        );

      expect(error).toBeInstanceOf(RagError);
      expect(error.code).toBe('EMBEDDING_UNAVAILABLE');
      expect(events).toEqual(['release-start', 'release-end']);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
