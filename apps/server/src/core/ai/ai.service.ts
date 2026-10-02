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
import { SearchResponseDto } from '../search/dto/search-response.dto';
import {
  ChatRetrievalOptionsDto,
  RagRetrievalOverridesDto,
  UpdateAiProviderDto,
} from './dto/ai.dto';
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
import { RagRetrieverService } from './rag/retrieval/rag-retriever.service';
import { RagChatRetrievalService } from './rag/retrieval/rag-chat-retrieval.service';
import { RagError, RagEvidence, RagRetrievalMeta } from './rag/contracts';
import { JsonValue } from '@docmost/db/types/db';

type AiProvider = {
  driver: string;
  baseUrl: string;
  chatModel: string;
  embeddingModel?: string;
  apiKey?: string;
};

/**
 * Shared provider endpoint helpers. `model` overrides the provider's default
 * chat model in driver-specific URL positions (gemini), so auxiliary model
 * calls (e.g. the RAG chat rewrite) can target a configured alternate model.
 */
export function chatUrlFor(
  provider: { driver: string; baseUrl: string; chatModel: string },
  model?: string,
) {
  const chatModel = model ?? provider.chatModel;
  if (provider.driver === 'ollama')
    return new URL('/api/chat', provider.baseUrl).toString();
  if (provider.driver === 'gemini')
    return new URL(
      `/v1beta/models/${encodeURIComponent(chatModel)}:generateContent`,
      provider.baseUrl,
    ).toString();
  return new URL('/v1/chat/completions', provider.baseUrl).toString();
}

export function providerHeadersFor(provider: {
  driver: string;
  apiKey?: string;
}) {
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
    private readonly ragRetriever: RagRetrieverService,
    private readonly ragChatRetrieval: RagChatRetrievalService,
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
    const rows = await this.db
      .selectFrom('aiChatMessages')
      .select(['id', 'role', 'content', 'metadata', 'createdAt'])
      .where('chatId', '=', chat.id)
      .where('workspaceId', '=', user.workspaceId)
      .where('deletedAt', 'is', null)
      .orderBy('createdAt', 'asc')
      .limit(200)
      .execute();
    return {
      ...chat,
      messages: rows.map((row) =>
        row.role === 'assistant' ? this.assistantMessageView(row) : row,
      ),
    };
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
    retrieval?: ChatRetrievalOptionsDto,
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
      user.id,
      requestId,
      this.workspaceKnowledgeOnly(workspace),
      attachmentContext,
      retrieval,
    );
    await this.db
      .updateTable('aiChats')
      .set({ updatedAt: new Date() })
      .where('id', '=', chat.id)
      .execute();
    return { message, assistant: this.assistantMessageView(assistant) };
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
    mode?: 'semantic' | 'keyword' | 'hybrid',
    overrides?: RagRetrievalOverridesDto,
  ): Promise<{ items: SearchResponseDto[]; retrieval: RagRetrievalMeta }> {
    this.requireSearch(workspace);
    // Hybrid RAG is the default item source (docmost-rag-v1 contract 12):
    // items are built from the actual retrieval results (all modes), not
    // from the lexical page search. The legacy semantic index serves only
    // title-only queries and when RAG is unavailable or returns nothing.
    if (!titleOnly) {
      try {
        const result = await this.ragRetriever.retrieve(
          { userId: user.id, workspaceId: workspace.id },
          {
            query,
            mode: mode ?? 'hybrid',
            limit: 25,
            ...(spaceId ? { spaceId } : {}),
            ...(overrides ? { overrides } : {}),
          },
        );
        const items = await this.hydrateEvidencePages(
          result.evidence,
          workspace.id,
        );
        if (items.length > 0) {
          return { items, retrieval: result.retrieval };
        }
      } catch (error) {
        // RagError or an unreachable index means the RAG side is
        // unavailable for this workspace; the legacy index still serves.
        // Anything else is a real failure.
        if (!(error instanceof RagError) && !this.isIndexUnavailable(error))
          throw error;
      }
    }
    const response = await this.searchService.searchPage(
      { query, spaceId, titleOnly, limit: 25, offset: 0 },
      { userId: user.id, workspaceId: workspace.id },
    );
    if (!titleOnly) {
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
    }
    // The executed legacy stage is semantic ranking; rerank never applies.
    return {
      ...response,
      retrieval: { mode: 'semantic', rerankStatus: 'not_applicable' },
    };
  }

  /**
   * Projects retrieval evidence into page search items, preserving evidence
   * order. Every evidence pageId was authorized inside the retriever; this
   * hydrates the current page/space fields and drops pages deleted since.
   */
  private async hydrateEvidencePages(
    evidence: RagEvidence[],
    _workspaceId: string,
  ): Promise<SearchResponseDto[]> {
    const pageIds: string[] = [];
    for (const item of evidence) {
      if (!pageIds.includes(item.key.pageId)) {
        pageIds.push(item.key.pageId);
      }
    }
    if (pageIds.length === 0) return [];
    const rows = await this.db
      .selectFrom('pages')
      .select((eb) => [
        'pages.id',
        'pages.slugId',
        'pages.title',
        'pages.icon',
        'pages.parentPageId',
        'pages.creatorId',
        'pages.createdAt',
        'pages.updatedAt',
        this.pageRepo.withSpace(eb),
      ])
      .where('pages.id', 'in', pageIds)
      .where('pages.deletedAt', 'is', null)
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const items: SearchResponseDto[] = [];
    for (const pageId of pageIds) {
      const page = byId.get(pageId);
      if (!page) continue;
      items.push({
        id: page.id,
        title: page.title,
        icon: page.icon,
        parentPageId: page.parentPageId,
        creatorId: page.creatorId,
        rank: 0,
        highlight: '',
        matchedText: [],
        wholeWord: false,
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
        space: page.space,
      });
    }
    return items;
  }

  private async complete(
    workspace: Workspace,
    chatId: string,
    userId: string,
    requestId?: string,
    workspaceOnly = false,
    attachmentContext?: string,
    retrieval?: ChatRetrievalOptionsDto,
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
    const rag = await this.retrieveRagContext(
      workspace,
      userId,
      messages,
      Boolean(attachmentContext),
      retrieval,
    );
    const ragContext = rag?.context ?? null;
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
              ragContext,
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
        const assistantMetadata: JsonValue = rag
          ? ({
              retrieval: rag.retrieval,
              sources: await this.hydrateCitationSources(rag.evidence),
            } as unknown as JsonValue)
          : null;
        return this.db
          .insertInto('aiChatMessages')
          .values({
            chatId,
            workspaceId: workspace.id,
            userId: null,
            role: 'assistant',
            content,
            metadata: assistantMetadata,
          })
          .returning(['id', 'role', 'content', 'metadata', 'createdAt'])
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
    return chatUrlFor(provider);
  }

  private chatRequest(
    provider: AiProvider,
    messages: Array<{ role: string; content: string | null }>,
    workspaceOnly: boolean,
    attachmentContext?: string,
    ragContext?: string,
  ) {
    const policy = workspaceOnly
      ? 'Answer only from the supplied workspace context. Do not use external knowledge.'
      : undefined;
    const instructions = [
      policy,
      attachmentContext
        ? `Authorized attachment context:\n${attachmentContext}`
        : undefined,
      ragContext ? `Authorized workspace context:\n${ragContext}` : undefined,
    ]
      .filter(Boolean)
      .join('\n\n');
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

  /**
   * Hybrid RAG retrieval for chat (docmost-rag-v1 contract 12): rewrite,
   * retrieval, expansion and rerank happen inside RagChatRetrievalService;
   * every returned chunk was rechecked for authorization at the retrieval
   * boundary. Any failure yields null so chat works unchanged without RAG.
   */
  private async retrieveRagContext(
    workspace: Workspace,
    userId: string,
    messages: Array<{ role: string; content: string | null }>,
    hasAttachments: boolean,
    retrieval?: ChatRetrievalOptionsDto,
  ): Promise<{
    context: string;
    evidence: RagEvidence[];
    retrieval: RagRetrievalMeta;
  } | null> {
    const lastUser = [...messages]
      .reverse()
      .find((message) => message.role === 'user' && message.content?.trim());
    if (!lastUser?.content) return null;
    try {
      const output = await this.ragChatRetrieval.retrieveForChat(
        { userId, workspaceId: workspace.id },
        {
          query: lastUser.content.trim(),
          history: messages
            .slice(0, messages.indexOf(lastUser))
            .map((message) => ({
              role: message.role as 'user' | 'assistant',
              content: message.content,
            })),
          attachmentFileNames: hasAttachments ? ['(attached documents)'] : [],
          ...(retrieval?.mode ? { mode: retrieval.mode } : {}),
          ...(retrieval?.spaceId ? { spaceId: retrieval.spaceId } : {}),
          ...(retrieval?.pageIds?.length ? { pageIds: retrieval.pageIds } : {}),
          ...(retrieval?.overrides ? { overrides: retrieval.overrides } : {}),
        },
      );
      if (output.evidence.length === 0) return null;
      const context = output.evidence
        .map((evidence, index) => {
          const heading = evidence.locator?.headingPath?.length
            ? `, ${evidence.locator.headingPath.join(' > ')}`
            : '';
          return `[${index + 1}] (page ${evidence.key.pageId}${heading})\n${evidence.text}`;
        })
        .join('\n\n');
      return {
        context,
        evidence: output.evidence,
        retrieval: output.retrieval,
      };
    } catch {
      return null;
    }
  }

  /**
   * Persisted citation sources for the assistant message: one entry per
   * evidence chunk, hydrated with the page title and canonical page URL.
   * Evidence pageIds are authorized at the retrieval boundary; pages
   * deleted since are skipped.
   */
  private async hydrateCitationSources(evidence: RagEvidence[]): Promise<
    Array<{
      citationId: string;
      pageId: string;
      title: string | null;
      url: string;
      locator: RagEvidence['locator'];
    }>
  > {
    const pageIds = [...new Set(evidence.map((item) => item.key.pageId))];
    if (pageIds.length === 0) return [];
    const rows = await this.db
      .selectFrom('pages')
      .select((eb) => [
        'pages.id',
        'pages.slugId',
        'pages.title',
        this.pageRepo.withSpace(eb),
      ])
      .where('pages.id', 'in', pageIds)
      .where('pages.deletedAt', 'is', null)
      .execute();
    const byId = new Map(rows.map((row) => [row.id, row]));
    return evidence.flatMap((item, index) => {
      const page = byId.get(item.key.pageId);
      if (!page) return [];
      return [
        {
          citationId: String(index + 1),
          pageId: page.id,
          title: page.title,
          url: `/s/${page.space.slug}/p/${page.slugId}`,
          locator: item.locator,
        },
      ];
    });
  }

  /**
   * The assistant message view: the retrieval metadata and citation sources
   * stored in the message metadata are projected to top-level fields.
   */
  private assistantMessageView(row: {
    id: string;
    role: string;
    content: string | null;
    metadata: unknown;
    createdAt: Date;
  }) {
    const meta = (row.metadata ?? null) as {
      retrieval?: RagRetrievalMeta;
      sources?: Array<{
        citationId: string;
        pageId: string;
        title: string | null;
        url: string;
        locator: unknown;
      }>;
    } | null;
    return {
      id: row.id,
      role: row.role,
      content: row.content,
      createdAt: row.createdAt,
      ...(meta?.retrieval ? { retrieval: meta.retrieval } : {}),
      ...(meta?.sources ? { sources: meta.sources } : {}),
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
    return providerHeadersFor(provider);
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
