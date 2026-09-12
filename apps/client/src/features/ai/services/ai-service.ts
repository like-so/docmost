import api from "@/lib/api-client";

export type AiChat = {
  id: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
};
export type AiMessage = {
  id: string;
  role: "user" | "assistant";
  content: string | null;
  createdAt: string;
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
) {
  return (
    await api.post("/ai/chats/message", {
      chatId,
      content,
      attachmentIds,
      requestId,
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
export async function semanticSearch(query: string, spaceId?: string) {
  return (await api.post("/ai/search", { query, spaceId })).data as {
    items: unknown[];
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
