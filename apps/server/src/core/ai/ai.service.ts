import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { request } from 'undici';
import { InjectKysely } from 'nestjs-kysely';
import { KyselyDB } from '@docmost/db/types/kysely.types';
import { WorkspaceRepo } from '@docmost/db/repos/workspace/workspace.repo';
import { AttachmentRepo } from '@docmost/db/repos/attachment/attachment.repo';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { EncryptionService } from '../../integrations/encryption/encryption.service';
import { OutboundAgentFactory } from '../../integrations/outbound/outbound-agent.factory';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { SearchService } from '../search/search.service';
import { UpdateAiProviderDto } from './dto/ai.dto';
import { AiIndexService } from './ai-index.service';
import { AttachmentService } from '../attachment/services/attachment.service';
import { AttachmentType } from '../attachment/attachment.constants';
import { PageRepo } from '@docmost/db/repos/page/page.repo';
import { PageAccessService } from '../page/page-access/page-access.service';
import { AuditEvent, AuditResource } from '../../common/events/audit-events';
import {
  AUDIT_SERVICE,
  IAuditService,
} from '../../integrations/audit/audit.service';

type AiProvider = {
  driver: string;
  baseUrl: string;
  chatModel: string;
  embeddingModel?: string;
  apiKey?: string;
};

@Injectable()
export class AiService {
  private readonly requests = new Map<string, AbortController>();
  constructor(
    @InjectKysely() private readonly db: KyselyDB,
    private readonly workspaceRepo: WorkspaceRepo,
    private readonly attachmentRepo: AttachmentRepo,
    private readonly encryption: EncryptionService,
    private readonly outboundAgent: OutboundAgentFactory,
    private readonly environment: EnvironmentService,
    private readonly searchService: SearchService,
    private readonly indexService: AiIndexService,
    private readonly attachmentService: AttachmentService,
    private readonly pageRepo: PageRepo,
    private readonly pageAccessService: PageAccessService,
    @Inject(AUDIT_SERVICE) private readonly auditService: IAuditService,
  ) {}

  async getProvider(workspace: Workspace) {
    return this.redactProvider(this.readProvider(workspace));
  }

  async updateProvider(workspace: Workspace, input: UpdateAiProviderDto) {
    const provider = this.validateProvider({
      ...this.readProvider(workspace),
      ...input,
      apiKey: input.apiKey?.trim() || this.readProvider(workspace)?.apiKey,
    } as UpdateAiProviderDto);
    await this.workspaceRepo.updateAiProviderSettings(
      workspace.id,
      this.encryption.encrypt(JSON.stringify(provider)),
    );
    await this.auditService.logWithContext(
      {
        event: AuditEvent.AI_PROVIDER_UPDATED,
        resourceType: AuditResource.AI_PROVIDER,
        resourceId: workspace.id,
        changes: {
          after: {
            driver: provider.driver,
            baseUrl: provider.baseUrl,
            chatModel: provider.chatModel,
            embeddingModel: provider.embeddingModel,
          },
        },
      },
      { workspaceId: workspace.id },
    );
    return this.redactProvider(provider);
  }

  async listChats(user: User) {
    return this.db
      .selectFrom('aiChats')
      .select(['id', 'title', 'createdAt', 'updatedAt'])
      .where('workspaceId', '=', user.workspaceId)
      .where('creatorId', '=', user.id)
      .where('deletedAt', 'is', null)
      .orderBy('updatedAt', 'desc')
      .limit(100)
      .execute();
  }

  async createChat(user: User, workspace: Workspace, title?: string) {
    this.requireChatWrite(workspace);
    const chat = await this.db
      .insertInto('aiChats')
      .values({
        workspaceId: workspace.id,
        creatorId: user.id,
        title: title?.trim() || null,
      })
      .returning(['id', 'title', 'createdAt', 'updatedAt'])
      .executeTakeFirstOrThrow();
    await this.auditService.logWithContext(
      {
        event: AuditEvent.AI_CHAT_CREATED,
        resourceType: AuditResource.AI_CHAT,
        resourceId: chat.id,
        metadata: { title: chat.title ?? undefined },
      },
      { workspaceId: workspace.id, actorId: user.id },
    );
    return chat;
  }

  async getChat(user: User, chatId: string) {
    const chat = await this.findChat(user, chatId);
    const messages = await this.db
      .selectFrom('aiChatMessages')
      .select(['id', 'role', 'content', 'metadata', 'createdAt'])
      .where('chatId', '=', chat.id)
      .where('workspaceId', '=', user.workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .limit(200)
      .execute();
    return { ...chat, messages };
  }

  async deleteChat(user: User, workspace: Workspace, chatId: string) {
    this.requireChatWrite(workspace);
    await this.findChat(user, chatId);
    await this.db
      .updateTable('aiChats')
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where('id', '=', chatId)
      .where('workspaceId', '=', user.workspaceId)
      .execute();
    await this.auditService.logWithContext(
      {
        event: AuditEvent.AI_CHAT_DELETED,
        resourceType: AuditResource.AI_CHAT,
        resourceId: chatId,
      },
      { workspaceId: workspace.id, actorId: user.id },
    );
    await this.attachmentService.handleDeleteAiChatAttachments(chatId);
  }

  async addMessage(
    user: User,
    workspace: Workspace,
    chatId: string,
    content: string,
    attachmentIds: string[] = [],
    requestId?: string,
  ) {
    this.requireChatWrite(workspace);
    this.requireGenerative(workspace);
    const text = content.trim();
    if (!text && attachmentIds.length === 0)
      throw new BadRequestException('Message is empty');
    const chat = await this.findChat(user, chatId);
    const attachmentContext = await this.claimAttachments(
      attachmentIds,
      chat.id,
      user,
    );
    const message = await this.db
      .insertInto('aiChatMessages')
      .values({
        chatId: chat.id,
        workspaceId: workspace.id,
        userId: user.id,
        role: 'user',
        content: text || null,
      })
      .returning(['id', 'role', 'content', 'createdAt'])
      .executeTakeFirstOrThrow();
    const assistant = await this.complete(
      workspace,
      chat.id,
      requestId,
      this.workspaceKnowledgeOnly(workspace),
      attachmentContext,
    );
    await this.db
      .updateTable('aiChats')
      .set({ updatedAt: new Date() })
      .where('id', '=', chat.id)
      .execute();
    return { message, assistant };
  }

  async cancel(user: User, chatId: string, requestId: string) {
    await this.findChat(user, chatId);
    const key = this.requestKey(user.workspaceId, chatId, requestId);
    this.requests.get(key)?.abort();
    this.requests.delete(key);
  }

  async semanticSearch(
    user: User,
    workspace: Workspace,
    query: string,
    spaceId?: string,
    titleOnly?: boolean,
  ) {
    this.requireSearch(workspace);
    const response = await this.searchService.searchPage(
      { query, spaceId, titleOnly, limit: 25, offset: 0 },
      { userId: user.id, workspaceId: workspace.id },
    );
    try {
      const order = await this.indexService.rank(
        query,
        response.items.map((item) => item.id),
        workspace.id,
      );
      const rank = new Map(order.map((id, index) => [id, index]));
      response.items.sort(
        (left, right) =>
          (rank.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (rank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      );
    } catch (error) {
      if (!this.isIndexUnavailable(error)) throw error;
    }
    return response;
  }

  private async complete(
    workspace: Workspace,
    chatId: string,
    requestId?: string,
    workspaceOnly = false,
    attachmentContext?: string,
  ) {
    const provider = this.readProvider(workspace);
    if (!provider?.apiKey)
      throw new ServiceUnavailableException('AI provider is not configured');
    const messages = await this.db
      .selectFrom('aiChatMessages')
      .select(['role', 'content'])
      .where('chatId', '=', chatId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .limit(40)
      .execute();
    const url = this.chatUrl(provider);
    const key = requestId
      ? this.requestKey(workspace.id, chatId, requestId)
      : undefined;
    const controller = key ? new AbortController() : undefined;
    if (key && controller) this.requests.set(key, controller);
    try {
      const lease = await this.outboundAgent.lease(url);
      try {
        const response = await request(url, {
          method: 'POST',
          signal: this.requestSignal(controller),
          dispatcher: lease.dispatcher,
          headers: this.providerHeaders(provider),
          body: JSON.stringify(
            this.chatRequest(
              provider,
              messages,
              workspaceOnly,
              attachmentContext,
            ),
          ),
        });
        if (response.statusCode < 200 || response.statusCode >= 300)
          throw new BadGatewayException('AI provider rejected the request');
        const result = (await response.body.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
          message?: { content?: string };
          candidates?: Array<{
            content?: { parts?: Array<{ text?: string }> };
          }>;
        };
        const content =
          result.choices?.[0]?.message?.content?.trim() ??
          result.message?.content?.trim() ??
          result.candidates?.[0]?.content?.parts
            ?.map((part) => part.text ?? '')
            .join('')
            .trim();
        if (!content)
          throw new BadGatewayException(
            'AI provider returned an empty response',
          );
        return this.db
          .insertInto('aiChatMessages')
          .values({
            chatId,
            workspaceId: workspace.id,
            userId: null,
            role: 'assistant',
            content,
          })
          .returning(['id', 'role', 'content', 'createdAt'])
          .executeTakeFirstOrThrow();
      } finally {
        await lease.release();
      }
    } catch (error) {
      if (error instanceof BadGatewayException) throw error;
      if (this.isProviderUnavailable(error))
        throw new ServiceUnavailableException('AI provider is unavailable');
      throw error;
    } finally {
      if (key) this.requests.delete(key);
    }
  }

  private async findChat(user: User, chatId: string) {
    const chat = await this.db
      .selectFrom('aiChats')
      .select(['id', 'title', 'createdAt', 'updatedAt'])
      .where('id', '=', chatId)
      .where('workspaceId', '=', user.workspaceId)
      .where('creatorId', '=', user.id)
      .where('deletedAt', 'is', null)
      .executeTakeFirst();
    if (!chat) throw new NotFoundException('Chat not found');
    return chat;
  }

  private async claimAttachments(ids: string[], chatId: string, user: User) {
    if (ids.length > 10) throw new BadRequestException('Too many attachments');
    const attachments = [] as Array<{
      fileName: string;
      textContent: string | null;
    }>;
    const chatAttachmentIds: string[] = [];
    for (const id of new Set(ids)) {
      const attachment = await this.attachmentRepo.findByIdWithContent(id);
      if (
        !attachment ||
        attachment.workspaceId !== user.workspaceId ||
        attachment.deletedAt ||
        !this.isChatAttachment(attachment)
      )
        throw new ForbiddenException('Attachment is not available');
      if (attachment.type === AttachmentType.Chat) {
        if (
          attachment.creatorId !== user.id ||
          (attachment.aiChatId && attachment.aiChatId !== chatId)
        )
          throw new ForbiddenException('Attachment is not available');
        chatAttachmentIds.push(id);
      } else if (attachment.type === AttachmentType.File && attachment.pageId) {
        const page = await this.pageRepo.findById(attachment.pageId);
        if (!page || page.deletedAt)
          throw new ForbiddenException('Attachment is not available');
        await this.pageAccessService.validateCanView(page, user);
      } else {
        throw new ForbiddenException('Attachment is not available');
      }
      attachments.push(attachment);
    }
    await this.attachmentRepo.claimAttachmentsForChat(
      chatAttachmentIds,
      chatId,
      user.id,
      user.workspaceId,
    );
    return this.attachmentContext(attachments);
  }

  private readProvider(workspace: Workspace): AiProvider | undefined {
    const settings = workspace.settings as {
      ai?: { providerSecret?: string };
    } | null;
    const secret = settings?.ai?.providerSecret;
    if (!secret) return undefined;
    return this.validateProvider(JSON.parse(this.encryption.decrypt(secret)));
  }

  private validateProvider(input: UpdateAiProviderDto): AiProvider {
    let url: URL;
    try {
      url = new URL(input.baseUrl);
    } catch {
      throw new BadRequestException('AI provider URL is invalid');
    }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost')
      throw new BadRequestException('AI provider URL must use HTTPS');
    if (!input.driver)
      throw new BadRequestException('AI provider driver is required');
    return {
      driver: input.driver,
      baseUrl: url.toString(),
      chatModel: input.chatModel.trim(),
      embeddingModel: input.embeddingModel?.trim(),
      apiKey: input.apiKey?.trim(),
    };
  }

  private chatUrl(provider: AiProvider) {
    if (provider.driver === 'ollama')
      return new URL('/api/chat', provider.baseUrl).toString();
    if (provider.driver === 'gemini')
      return new URL(
        `/v1beta/models/${encodeURIComponent(provider.chatModel)}:generateContent`,
        provider.baseUrl,
      ).toString();
    return new URL('/v1/chat/completions', provider.baseUrl).toString();
  }

  private chatRequest(
    provider: AiProvider,
    messages: Array<{ role: string; content: string | null }>,
    workspaceOnly: boolean,
    attachmentContext?: string,
  ) {
    const policy = workspaceOnly
      ? 'Answer only from the supplied workspace context. Do not use external knowledge.'
      : undefined;
    const context = attachmentContext
      ? `Authorized attachment context:\n${attachmentContext}`
      : undefined;
    const instructions = [policy, context].filter(Boolean).join('\n\n');
    if (provider.driver === 'ollama')
      return {
        model: provider.chatModel,
        messages: instructions
          ? [{ role: 'system', content: instructions }, ...messages]
          : messages,
        stream: false,
      };
    if (provider.driver === 'gemini')
      return {
        contents: [
          ...(instructions ? [{ role: 'user', content: instructions }] : []),
          ...messages,
        ].map((message) => ({
          role: message.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: message.content ?? '' }],
        })),
      };
    return {
      model: provider.chatModel,
      messages: instructions
        ? [{ role: 'system', content: instructions }, ...messages]
        : messages,
      max_tokens: 2048,
    };
  }

  private redactProvider(provider?: AiProvider) {
    if (!provider) return { configured: false };
    return {
      configured: Boolean(provider.apiKey),
      driver: provider.driver,
      baseUrl: provider.baseUrl,
      chatModel: provider.chatModel,
      embeddingModel: provider.embeddingModel,
    };
  }

  private attachmentContext(
    attachments: Array<{ fileName: string; textContent: string | null }>,
  ) {
    const limit = 24_000;
    let remaining = limit;
    return attachments
      .map((attachment) => {
        if (remaining <= 0) return '';
        const content = `${attachment.fileName}: ${attachment.textContent ?? ''}`;
        const bounded = content.slice(0, remaining);
        remaining -= bounded.length;
        return bounded;
      })
      .filter(Boolean)
      .join('\n\n');
  }

  private isChatAttachment(attachment: { fileExt: string; mimeType: string }) {
    return (
      new Map([
        ['.txt', 'text/plain'],
        ['.pdf', 'application/pdf'],
        [
          '.docx',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ],
      ]).get(attachment.fileExt.toLowerCase()) === attachment.mimeType
    );
  }

  private requireChatWrite(workspace: Workspace) {
    const ai = (workspace.settings as { ai?: Record<string, boolean> } | null)
      ?.ai;
    if (ai?.chat !== true) throw new ForbiddenException('AI chat is disabled');
    if (ai.chatReadOnly === true)
      throw new ForbiddenException('AI chat is read-only');
  }

  private requireGenerative(workspace: Workspace) {
    if (
      (workspace.settings as { ai?: Record<string, boolean> } | null)?.ai
        ?.generative !== true
    )
      throw new ForbiddenException('Generative AI is disabled');
  }

  private workspaceKnowledgeOnly(workspace: Workspace) {
    return (
      (workspace.settings as { ai?: Record<string, boolean> } | null)?.ai
        ?.chatWorkspaceKnowledgeOnly === true
    );
  }

  private requestKey(workspaceId: string, chatId: string, requestId: string) {
    return `${workspaceId}:${chatId}:${requestId}`;
  }

  private providerHeaders(provider: AiProvider) {
    return provider.driver === 'gemini'
      ? {
          'content-type': 'application/json',
          'x-goog-api-key': provider.apiKey ?? '',
        }
      : {
          authorization: `Bearer ${provider.apiKey}`,
          'content-type': 'application/json',
        };
  }

  private requestSignal(controller?: AbortController) {
    const timeout = AbortSignal.timeout(
      this.environment.getAiRequestTimeoutMs(),
    );
    return controller ? AbortSignal.any([controller.signal, timeout]) : timeout;
  }

  private isProviderUnavailable(error: unknown) {
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: string }).code;
    return (
      ['AbortError', 'TimeoutError'].includes(error.name) ||
      ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ETIMEDOUT'].includes(
        code ?? '',
      )
    );
  }

  private isIndexUnavailable(error: unknown) {
    if (error instanceof ServiceUnavailableException) return true;
    if (!(error instanceof Error)) return false;
    const code = (error as Error & { code?: string }).code;
    return ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'ETIMEDOUT'].includes(
      code ?? '',
    );
  }

  private requireSearch(workspace: Workspace) {
    if (
      (workspace.settings as { ai?: Record<string, boolean> } | null)?.ai
        ?.search !== true
    )
      throw new ForbiddenException('AI search is disabled');
  }
}
