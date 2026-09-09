import { Alert, Button, Group, Stack, Text, Title } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import ChatInput from "../components/chat-input";
import {
  cancelChatRequest,
  createChat,
  getChat,
  sendChatMessage,
  uploadChatAttachment,
  type AiMessage,
} from "../services/ai-service";
import type { ChatAttachment } from "../components/chat-input";

export default function AiChat() {
  const { chatId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [requestId, setRequestId] = useState<string>();
  const [activeChatId, setActiveChatId] = useState<string>();
  const initialSent = useRef(false);
  const createdChatId = useRef<string | null>(null);
  useEffect(() => {
    if (chatId)
      getChat(chatId)
        .then((chat) => setMessages(chat.messages))
        .catch(() => setError("Chat is unavailable"));
  }, [chatId]);
  const ensureChat = async (title: string) => {
    const id = chatId ?? createdChatId.current;
    if (id) return id;
    const chat = await createChat(title.slice(0, 80));
    createdChatId.current = chat.id;
    navigate(`/ai/chat/${chat.id}`, { replace: true });
    return chat.id;
  };
  const send = async (content: string, attachments: ChatAttachment[] = []) => {
    setBusy(true);
    setError(undefined);
    try {
      const id = await ensureChat(content || "Attachment");
      const activeRequest = crypto.randomUUID();
      setActiveChatId(id);
      setRequestId(activeRequest);
      const result = await sendChatMessage(
        id,
        content,
        attachments.map((attachment) => attachment.id),
        activeRequest,
      );
      setMessages((current) => [...current, result.message, result.assistant]);
    } catch {
      setError("AI could not answer this request.");
    } finally {
      setRequestId(undefined);
      setActiveChatId(undefined);
      setBusy(false);
    }
  };
  const uploadAttachment = async (file: File) => {
    const id = await ensureChat(file.name);
    return uploadChatAttachment(id, file);
  };
  useEffect(() => {
    const initial = location.state as
      | { initialContent?: string; initialAttachments?: ChatAttachment[] }
      | null;
    const initialContent = initial?.initialContent ?? "";
    const initialAttachments = initial?.initialAttachments ?? [];
    if (
      chatId ||
      (!initialContent && initialAttachments.length === 0) ||
      initialSent.current
    )
      return;
    initialSent.current = true;
    navigate(location.pathname, { replace: true, state: null });
    void send(initialContent, initialAttachments);
  }, [chatId, location.pathname, location.state, navigate]);
  return (
    <Stack maw={860} mx="auto">
      <Group justify="space-between">
        <Title order={1}>AI Chat</Title>
        <Button variant="default" onClick={() => navigate("/ai")}>
          New chat
        </Button>
      </Group>
      {error && <Alert color="red">{error}</Alert>}
      <Stack>
        {messages.map((message) => (
          <Text key={message.id} fw={message.role === "assistant" ? 400 : 700}>
            {message.content}
          </Text>
        ))}
      </Stack>
      <ChatInput
        disabled={busy}
        onSend={(content, _mentions, attachments) => send(content, attachments)}
        onUpload={uploadAttachment}
      />
      {busy && requestId && activeChatId && (
        <Button
          variant="default"
          onClick={() => cancelChatRequest(activeChatId, requestId)}
        >
          Stop
        </Button>
      )}
    </Stack>
  );
}
