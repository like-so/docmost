import api from "@/lib/api-client";

export type AiChat = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};
export type RagRerankStatus =
  | "applied"
  | "not_configured"
  | "failed"
  | "not_applicable";

export type RagRetrievalMetadata = {
  mode: RagRetrievalMode;
  rerankStatus: RagRerankStatus;
};

export type RagSourceReference = {
  citationId: string;
  pageId: string;
  title: string;
  url: string;
  locator: unknown;
};

export type AiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string | null;
  createdAt: string;
  retrieval?: RagRetrievalMetadata;
  sources?: RagSourceReference[];
};
export type AiProvider = {
  configured: boolean;
  driver?: string;
  baseUrl?: string;
  chatModel?: string;
  embeddingModel?: string;
};

export async function getAiProvider(): Promise<AiProvider> {
  return (await api.post("/ai/settings")).data;
}
export async function updateAiProvider(input: {
  driver: string;
  baseUrl: string;
  chatModel: string;
  embeddingModel?: string;
  apiKey?: string;
}): Promise<AiProvider> {
  return (await api.post("/ai/settings/update", input)).data;
}
export async function listChats(): Promise<AiChat[]> {
  return (await api.post("/ai/chats/list")).data;
}
export async function createChat(title?: string): Promise<AiChat> {
  return (await api.post("/ai/chats/create", { title })).data;
}
export async function getChat(
  chatId: string,
): Promise<AiChat & { messages: AiMessage[] }> {
  return (await api.post("/ai/chats/get", { chatId })).data;
}
export async function removeChat(chatId: string): Promise<void> {
  await api.post("/ai/chats/delete", { chatId });
}
export async function sendChatMessage(
  chatId: string,
  content: string,
  attachmentIds: string[] = [],
  requestId?: string,
  options?: { spaceId?: string; retrieval?: RagRetrievalOverride },
) {
  return (
    await api.post("/ai/chats/message", {
      chatId,
      content,
      attachmentIds,
      requestId,
      spaceId: options?.spaceId,
      retrieval: options?.retrieval,
    })
  ).data as { message: AiMessage; assistant: AiMessage };
}

export type ChatAttachmentUpload = {
  id: string;
  fileName: string;
  fileExt: string;
  fileSize: number;
  mimeType: string | null;
};

export async function uploadChatAttachment(
  chatId: string,
  file: File,
): Promise<ChatAttachmentUpload> {
  const formData = new FormData();
  formData.append("chatId", chatId);
  formData.append("file", file);
  return (
    await api.post("/ai/chats/attachments/upload", formData, {
      headers: { "Content-Type": "multipart/form-data" },
    })
  ).data;
}
export type RagRetrievalMode = "hybrid" | "semantic" | "keyword";

export type RagRetrievalConfig = {
  recallCount: number;
  vectorThreshold: number;
  keywordThreshold: number;
  rerankModel: string | null;
  rerankTopK: number;
  rerankThreshold: number;
};

export type RagChatRetrievalConfig = RagRetrievalConfig & {
  rewriteEnabled: boolean;
  expansionEnabled: boolean;
  queryUnderstandingModel: string | null;
  rewriteSystemPrompt: string;
  rewriteUserPrompt: string;
};

export type RagRetrievalOverride = Partial<
  Pick<
    RagRetrievalConfig,
    | "recallCount"
    | "vectorThreshold"
    | "keywordThreshold"
    | "rerankModel"
    | "rerankTopK"
    | "rerankThreshold"
  >
>;

export type RagRetrievalSettingsView = {
  search: RagRetrievalConfig;
  chat: RagChatRetrievalConfig;
};

export type RagIndexingStrategy = {
  vectorEnabled: boolean;
  keywordEnabled: boolean;
};

export type RagIndexProfileConfig = {
  parserVersion: string;
  chunkerVersion: string;
  maxChunkTokens: number;
  overlapTokens: number;
  sourcePolicy: {
    requiredMimeTypes: string[];
    imageInterpretation: "disabled" | "required";
  };
  embedding: {
    driver: string;
    endpointIdentity: string | null;
    model: string;
    dimensions: number;
    tokenizerId: string | null;
    maxInputTokens: number;
  };
  indexingStrategy?: RagIndexingStrategy;
};

export type RagIndexProfile = RagIndexProfileConfig & {
  profileId: string;
  profileHash: string;
};

export type RagSettingsView = {
  enabled: boolean;
  indexProfile: RagIndexProfile | null;
};

export async function getRagRetrievalSettings(): Promise<RagRetrievalSettingsView> {
  return (await api.get("/ai/rag/retrieval-settings"))
    .data as RagRetrievalSettingsView;
}

export async function updateRagRetrievalSettings(input: {
  search?: Partial<RagRetrievalConfig>;
  chat?: Partial<RagChatRetrievalConfig>;
}): Promise<RagRetrievalSettingsView> {
  return (await api.post("/ai/rag/retrieval-settings/update", input))
    .data as RagRetrievalSettingsView;
}

export async function getRagSettings(): Promise<RagSettingsView> {
  return (await api.post("/ai/rag/settings")).data as RagSettingsView;
}

export async function updateRagSettings(input: {
  enabled: boolean;
  indexProfileConfig: RagIndexProfileConfig;
}): Promise<RagSettingsView> {
  return (await api.post("/ai/rag/settings/update", input))
    .data as RagSettingsView;
}

export async function semanticSearch(
  query: string,
  spaceId?: string,
  options?: {
    titleOnly?: boolean;
    mode?: RagRetrievalMode;
    retrieval?: RagRetrievalOverride;
  },
) {
  return (await api.post("/ai/search", { query, spaceId, ...options }))
    .data as {
    items: unknown[];
    retrieval?: RagRetrievalMetadata;
  };
}

export async function updateAiControls(input: {
  aiSearch?: boolean;
  generativeAi?: boolean;
  aiChat?: boolean;
  aiChatReadOnly?: boolean;
  aiChatWorkspaceKnowledgeOnly?: boolean;
  mcpEnabled?: boolean;
  enforceMcpOauth?: boolean;
}) {
  return (await api.post("/workspace/update", input)).data;
}

export async function cancelChatRequest(
  chatId: string,
  requestId: string,
): Promise<void> {
  await api.post("/ai/chats/cancel", { chatId, requestId });
}
