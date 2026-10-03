import * as undici from 'undici';
import { Workspace } from '@docmost/db/types/entity.types';
import { EncryptionService } from '../../../../integrations/encryption/encryption.service';
import { EnvironmentService } from '../../../../integrations/environment/environment.service';
import { OutboundAgentFactory } from '../../../../integrations/outbound/outbound-agent.factory';
import { OpenAiCompatibleRerankAdapter } from './openai-compatible.rerank.adapter';

// Captured before any test can spy on `undici.request`: later spies replace
// the module export, so a lazy lookup inside a test would observe the mock.
const realUndiciRequest = jest.requireActual('undici')
  .request as typeof undici.request;

const API_KEY = 'sk-test-secret-value';

const PROVIDER_FIXTURE = {
  driver: 'openai-compatible',
  baseUrl: 'https://rerank.example.com/v1',
  chatModel: 'chat-model',
  apiKey: API_KEY,
};

const providerWorkspace = () =>
  ({
    id: 'workspace-1',
    settings: {
      ai: { providerSecret: 'encrypted-provider-secret' },
    },
  }) as unknown as Workspace;

const buildAdapter = (workspace: Workspace | null) => {
  const encryption = {
    decrypt: jest
      .fn()
      .mockReturnValue(JSON.stringify(PROVIDER_FIXTURE)),
  } as unknown as EncryptionService;
  const outboundAgent = {
    lease: jest.fn().mockResolvedValue({
      dispatcher: { mocked: true },
      release: jest.fn().mockResolvedValue(undefined),
    }),
  } as unknown as OutboundAgentFactory;
  const environment = {
    getAiRequestTimeoutMs: jest.fn().mockReturnValue(5000),
  } as unknown as EnvironmentService;
  const workspaceNode: any = {};
  for (const method of ['selectFrom', 'selectAll', 'where']) {
    workspaceNode[method] = jest.fn().mockReturnValue(workspaceNode);
  }
  workspaceNode.executeTakeFirst = jest.fn().mockResolvedValue(workspace);
  const adapter = new OpenAiCompatibleRerankAdapter(
    workspaceNode as never,
    encryption,
    outboundAgent,
    environment,
  );
  return { adapter, outboundAgent };
};

const okResponse = (results: unknown) =>
  ({
    statusCode: 200,
    body: {
      json: jest.fn().mockResolvedValue({ results, model: 'rerank-model' }),
      destroy: jest.fn(),
    },
  }) as unknown as Awaited<ReturnType<typeof undici.request>>;

beforeEach(() => {
  jest.spyOn(undici, 'request').mockReset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('OpenAiCompatibleRerankAdapter', () => {
  it('maps indexed scores in order and sends the requested model', async () => {
    const requestMock = jest
      .spyOn(undici, 'request')
      .mockResolvedValue(
        okResponse([
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.4 },
        ]),
      );
    const { adapter, outboundAgent } = buildAdapter(providerWorkspace());

    const result = await adapter.rerank(
      'workspace-1',
      'rerank-model',
      'query',
      ['passage one', 'passage two'],
    );

    expect(result.status).toBe('ok');
    expect(result.status === 'ok' && result.scores).toEqual([0.4, 0.9]);
    const [url, options] = requestMock.mock.calls[0];
    expect(String(url)).toBe('https://rerank.example.com/v1/rerank');
    expect(JSON.parse(options.body as string)).toEqual({
      model: 'rerank-model',
      query: 'query',
      documents: ['passage one', 'passage two'],
      top_n: 2,
    });
    expect((options.headers as Record<string, string>).authorization).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(String(options.body)).not.toContain(API_KEY);
    expect(options.dispatcher).toEqual({ mocked: true });
    expect(outboundAgent.lease).toHaveBeenCalledWith(
      'https://rerank.example.com/v1/rerank',
    );
  });

  it('fails a response with a hole in the indexed coverage', async () => {
    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(
        okResponse([{ index: 0, relevance_score: 0.9 }]),
      );
    const { adapter } = buildAdapter(providerWorkspace());

    const result = await adapter.rerank(
      'workspace-1',
      'rerank-model',
      'query',
      ['passage one', 'passage two'],
    );

    expect(result).toEqual({ status: 'failed' });
  });

  it('fails a response whose result count does not match the passages', async () => {
    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(okResponse([{ index: 0, relevance_score: 0.9 }]));
    const { adapter } = buildAdapter(providerWorkspace());

    const result = await adapter.rerank(
      'workspace-1',
      'rerank-model',
      'query',
      ['passage one', 'passage two'],
    );

    expect(result).toEqual({ status: 'failed' });
  });

  it('fails duplicate or nonfinite scores and out-of-range indexes', async () => {
    const { adapter } = buildAdapter(providerWorkspace());
    const duplicate = [
      { index: 0, relevance_score: 0.9 },
      { index: 0, relevance_score: 0.8 },
    ];
    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(okResponse(duplicate));
    await expect(
      adapter.rerank('workspace-1', 'rerank-model', 'q', ['a', 'b']),
    ).resolves.toEqual({ status: 'failed' });

    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(
        okResponse([
          { index: 0, relevance_score: Number.NaN },
          { index: 1, relevance_score: 0.8 },
        ]),
      );
    await expect(
      adapter.rerank('workspace-1', 'rerank-model', 'q', ['a', 'b']),
    ).resolves.toEqual({ status: 'failed' });

    jest
      .spyOn(undici, 'request')
      .mockResolvedValue(
        okResponse([
          { index: 2, relevance_score: 0.9 },
          { index: 1, relevance_score: 0.8 },
        ]),
      );
    await expect(
      adapter.rerank('workspace-1', 'rerank-model', 'q', ['a', 'b']),
    ).resolves.toEqual({ status: 'failed' });
  });
});
