import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import * as undici from 'undici';
import { AiService } from './ai.service';

const workspace = {
  id: 'ws',
  settings: { ai: { chat: true, generative: true, search: true } },
} as any;
const user = { id: 'user', workspaceId: 'ws' } as any;

function service() {
  const db: any = {
    selectFrom: jest.fn(),
    insertInto: jest.fn(),
    updateTable: jest.fn(),
  };
  return new AiService(
    db,
    { updateAiProviderSettings: jest.fn() } as any,
    { findById: jest.fn(), claimAttachmentsForChat: jest.fn() } as any,
    {
      encrypt: jest.fn((value) => `encrypted:${value}`),
      decrypt: jest.fn((value) => value.replace('encrypted:', '')),
    } as any,
    {} as any,
    { getAiRequestTimeoutMs: jest.fn().mockReturnValue(5_000) } as any,
    { searchPage: jest.fn().mockResolvedValue({ items: [] }) } as any,
    { rank: jest.fn().mockResolvedValue([]) } as any,
    { handleDeleteAiChatAttachments: jest.fn() } as any,
    { findById: jest.fn() } as any,
    { validateCanView: jest.fn() } as any,
    { logWithContext: jest.fn() } as any,
  ) as any;
}

describe('AiService settings and policy', () => {
  it('encrypts provider credentials and returns no credential', async () => {
    const instance = service();
    const result = await instance.updateProvider(
      { ...workspace, settings: {} },
      {
        driver: 'openai-compatible',
        baseUrl: 'https://ai.example.test',
        chatModel: 'chat',
        apiKey: 'secret',
      },
    );
    expect(instance['encryption'].encrypt).toHaveBeenCalledWith(
      expect.stringContaining('secret'),
    );
    expect(
      instance['workspaceRepo'].updateAiProviderSettings,
    ).toHaveBeenCalledWith('ws', expect.stringContaining('encrypted:'));
    expect(result).not.toHaveProperty('apiKey');
    expect(result.configured).toBe(true);
    expect(instance['auditService'].logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai.provider_updated' }),
      expect.objectContaining({ workspaceId: 'ws' }),
    );
  });

  it('denies chat mutations when disabled or read-only', async () => {
    const instance = service();
    await expect(
      instance.createChat(user, { ...workspace, settings: { ai: {} } }, 'x'),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      instance.createChat(
        user,
        { ...workspace, settings: { ai: { chat: true, chatReadOnly: true } } },
        'x',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('returns the current user chat rows', async () => {
    const instance = service();
    const rows = [{ id: 'chat', title: 'Chat' }];
    instance.db.selectFrom.mockReturnValue({
      select: () => ({
        where: () => ({
          where: () => ({
            where: () => ({
              orderBy: () => ({
                limit: () => ({ execute: jest.fn().mockResolvedValue(rows) }),
              }),
            }),
          }),
        }),
      }),
    });

    await expect(instance.listChats(user)).resolves.toEqual(rows);
  });

  it('audits and returns a created chat', async () => {
    const instance = service();
    const chat = {
      id: 'chat',
      title: 'Chat',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    instance.db.insertInto.mockReturnValue({
      values: () => ({
        returning: () => ({
          executeTakeFirstOrThrow: jest.fn().mockResolvedValue(chat),
        }),
      }),
    });

    await expect(instance.createChat(user, workspace, 'Chat')).resolves.toEqual(
      chat,
    );
    expect(instance.auditService.logWithContext).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'ai.chat_created', resourceId: 'chat' }),
      { workspaceId: 'ws', actorId: 'user' },
    );
  });

  it('requires generative AI before writing a chat message', async () => {
    const instance = service();
    await expect(
      instance.addMessage(
        user,
        { ...workspace, settings: { ai: { chat: true } } },
        'chat',
        'hello',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('uses one owner-bound cancellation key for a chat request', async () => {
    const instance = service();
    const abort = jest.fn();
    instance.requests.set('ws:chat:request', { abort } as any);
    jest.spyOn(instance, 'findChat').mockImplementation((actor: any) => {
      if (actor.id !== user.id) throw new ForbiddenException();
      return Promise.resolve({ id: 'chat' } as any);
    });
    await instance.cancel(user, 'chat', 'request');
    expect(abort).toHaveBeenCalled();
    await expect(
      instance.cancel({ ...user, id: 'other' }, 'other', 'request'),
    ).rejects.toThrow();
  });

  it('adds an explicit workspace-only provider policy', () => {
    const instance = service();
    expect(
      instance.chatRequest(
        {
          driver: 'openai',
          baseUrl: 'https://ai.example.test',
          chatModel: 'x',
        },
        [{ role: 'user', content: 'hello' }],
        true,
      ).messages[0],
    ).toMatchObject({
      role: 'system',
      content: expect.stringContaining('workspace'),
    });
  });

  it('adds bounded authorized attachment content to provider context', () => {
    const instance = service();
    const context = instance.attachmentContext([
      { fileName: 'notes.txt', textContent: 'approved content' },
    ]);
    expect(
      instance.chatRequest(
        {
          driver: 'openai',
          baseUrl: 'https://ai.example.test',
          chatModel: 'x',
        },
        [{ role: 'user', content: 'hello' }],
        false,
        context,
      ).messages[0],
    ).toMatchObject({ content: expect.stringContaining('approved content') });
    expect(
      instance.attachmentContext([
        { fileName: 'large.txt', textContent: 'x'.repeat(30_000) },
      ]).length,
    ).toBeLessThanOrEqual(24_000);
  });

  it('uses only an authorized chat attachment as model context', async () => {
    const instance = service();
    instance.attachmentRepo.findByIdWithContent = jest
      .fn()
      .mockResolvedValue({
        workspaceId: 'ws',
        creatorId: 'user',
        aiChatId: null,
        type: 'chat',
        fileExt: '.txt',
        mimeType: 'text/plain',
        deletedAt: null,
        fileName: 'notes.txt',
        textContent: 'approved content',
      });
    await expect(
      instance.claimAttachments(['attachment'], 'chat', user),
    ).resolves.toContain('approved content');
    expect(
      instance.attachmentRepo.claimAttachmentsForChat,
    ).toHaveBeenCalledWith(['attachment'], 'chat', 'user', 'ws');
  });

  it('accepts an upload already bound to the same chat', async () => {
    const instance = service();
    instance.attachmentRepo.findByIdWithContent = jest
      .fn()
      .mockResolvedValue({
        workspaceId: 'ws',
        creatorId: 'user',
        aiChatId: 'chat',
        type: 'chat',
        fileExt: '.txt',
        mimeType: 'text/plain',
        deletedAt: null,
        fileName: 'notes.txt',
        textContent: 'uploaded content',
      });

    await expect(
      instance.claimAttachments(['attachment'], 'chat', user),
    ).resolves.toContain('uploaded content');
  });

  it('checks current page access before using a page attachment', async () => {
    const instance = service();
    instance.attachmentRepo.findByIdWithContent = jest
      .fn()
      .mockResolvedValue({
        workspaceId: 'ws',
        type: 'file',
        pageId: 'page',
        fileName: 'notes.txt',
        textContent: 'approved content',
        fileExt: '.txt',
        mimeType: 'text/plain',
        deletedAt: null,
      });
    instance.pageRepo.findById.mockResolvedValue({ id: 'page' });

    await instance.claimAttachments(['attachment'], 'chat', user);

    expect(instance.pageAccessService.validateCanView).toHaveBeenCalledWith(
      { id: 'page' },
      user,
    );
    expect(
      instance.attachmentRepo.claimAttachmentsForChat,
    ).toHaveBeenCalledWith([], 'chat', 'user', 'ws');
  });

  it('deletes chat-owned uploads when the owner deletes a chat', async () => {
    const instance = service();
    const execute = jest.fn().mockResolvedValue(undefined);
    instance.db.updateTable.mockReturnValue({
      set: () => ({
        where: () => ({ where: () => ({ execute }) }),
      }),
    });
    jest.spyOn(instance, 'findChat').mockResolvedValue({ id: 'chat' } as any);

    await instance.deleteChat(user, workspace, 'chat');

    expect(instance.attachmentService.handleDeleteAiChatAttachments).toHaveBeenCalledWith(
      'chat',
    );
  });

  it('uses permission-filtered search only when enabled', async () => {
    const instance = service();
    await instance.semanticSearch(user, workspace, 'roadmap');
    expect(instance['searchService'].searchPage).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'roadmap' }),
      { userId: 'user', workspaceId: 'ws' },
    );
    await expect(
      instance.semanticSearch(
        user,
        { ...workspace, settings: { ai: {} } },
        'roadmap',
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('falls back only when semantic indexing is explicitly unavailable', async () => {
    const instance = service();
    instance.indexService.rank.mockRejectedValue(
      Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' }),
    );
    await expect(
      instance.semanticSearch(user, workspace, 'roadmap'),
    ).resolves.toEqual({ items: [] });
  });

  it('surfaces semantic index corruption instead of silently degrading', async () => {
    const instance = service();
    instance.indexService.rank.mockRejectedValue(new Error('invalid vector'));
    await expect(
      instance.semanticSearch(user, workspace, 'roadmap'),
    ).rejects.toThrow('invalid vector');
  });

  it('sends Gemini credentials only in a bounded request header', () => {
    const instance = service();
    const provider = {
      driver: 'gemini',
      baseUrl: 'https://generativelanguage.googleapis.com',
      chatModel: 'gemini-2.0-flash',
      apiKey: 'secret',
    };
    expect(instance.chatUrl(provider)).not.toContain('secret');
    expect(instance.providerHeaders(provider)).toEqual({
      'content-type': 'application/json',
      'x-goog-api-key': 'secret',
    });
    expect(instance.requestSignal()).toBeInstanceOf(AbortSignal);
  });

  it('does not call a provider without an encrypted key', async () => {
    const instance = service();
    const db = instance['db'];
    db.selectFrom.mockReturnValue({
      select: () => ({
        where: () => ({
          where: () => ({
            orderBy: () => ({
              limit: () => ({ execute: jest.fn().mockResolvedValue([]) }),
            }),
          }),
        }),
      }),
    });
    await expect(
      instance['complete']({ ...workspace, settings: {} }, 'chat'),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('does not disguise decryption failures as provider availability', () => {
    const instance = service();
    instance.encryption.decrypt.mockImplementation(() => {
      throw new Error('ciphertext is corrupt');
    });
    expect(() =>
      instance.readProvider({
        ...workspace,
        settings: { ai: { providerSecret: 'invalid' } },
      }),
    ).toThrow('ciphertext is corrupt');
  });

  it('cleans a request lease after a successful completion', async () => {
    const instance = service();
    instance.readProvider = jest.fn().mockReturnValue({
      driver: 'openai',
      baseUrl: 'https://ai.example.test',
      chatModel: 'chat',
      apiKey: 'secret',
    });
    instance.db.selectFrom.mockReturnValue({
      select: () => ({
        where: () => ({
          where: () => ({
            orderBy: () => ({ limit: () => ({ execute: jest.fn().mockResolvedValue([]) }) }),
          }),
        }),
      }),
    });
    const release = jest.fn();
    instance.outboundAgent.lease = jest.fn().mockResolvedValue({
      dispatcher: {},
      release,
    });
    const response = {
      statusCode: 200,
      body: { json: jest.fn().mockResolvedValue({ choices: [{ message: { content: 'ok' } }] }) },
    } as unknown as Awaited<ReturnType<typeof undici.request>>;
    jest.spyOn(undici, 'request').mockResolvedValue(response);
    instance.db.insertInto.mockReturnValue({
      values: () => ({ returning: () => ({ executeTakeFirstOrThrow: jest.fn().mockResolvedValue({}) }) }),
    });

    await instance.complete(workspace, 'chat', 'request');

    expect(instance.requests.has('ws:chat:request')).toBe(false);
    expect(release).toHaveBeenCalled();
  });
});
