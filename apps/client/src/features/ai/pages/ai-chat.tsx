import {
  Alert,
  Anchor,
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  Slider,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
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
  type RagRetrievalOverride,
} from "../services/ai-service";
import type { ChatAttachment } from "../components/chat-input";
import { useGetSpacesQuery } from "@/features/space/queries/space-query";
import { RetrievalStatusNotice } from "../components/retrieval-status-notice";

type ChatOverrideForm = {
  recallCount: number | null;
  vectorThreshold: number | null;
  keywordThreshold: number | null;
  rerankModelMode: "inherit" | "explicit" | "cleared";
  rerankModelText: string;
  rerankTopK: number | null;
  rerankThreshold: number | null;
};

const EMPTY_CHAT_OVERRIDES: ChatOverrideForm = {
  recallCount: null,
  vectorThreshold: null,
  keywordThreshold: null,
  rerankModelMode: "inherit",
  rerankModelText: "",
  rerankTopK: null,
  rerankThreshold: null,
};

function chatOverridePayload(
  form: ChatOverrideForm,
): RagRetrievalOverride | undefined {
  const payload: RagRetrievalOverride = {};
  if (form.recallCount != null) payload.recallCount = form.recallCount;
  if (form.vectorThreshold != null)
    payload.vectorThreshold = form.vectorThreshold;
  if (form.keywordThreshold != null)
    payload.keywordThreshold = form.keywordThreshold;
  if (form.rerankModelMode === "cleared") {
    // Explicit clear: the server drops the chat default selection and then
    // resolves a model normally. This is not a disable switch.
    payload.rerankModel = null;
  } else if (
    form.rerankModelMode === "explicit" &&
    form.rerankModelText.trim()
  ) {
    payload.rerankModel = form.rerankModelText.trim();
  }
  if (form.rerankTopK != null) payload.rerankTopK = form.rerankTopK;
  if (form.rerankThreshold != null)
    payload.rerankThreshold = form.rerankThreshold;
  return Object.keys(payload).length > 0 ? payload : undefined;
}

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
  const [scopeSpaceId, setScopeSpaceId] = useState<string | null>(null);
  const { data: spacesData } = useGetSpacesQuery({ limit: 100 });
  const [overridesOpen, setOverridesOpen] = useState(false);
  const [overrides, setOverrides] =
    useState<ChatOverrideForm>(EMPTY_CHAT_OVERRIDES);
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
        {
          spaceId: scopeSpaceId || undefined,
          retrieval: chatOverridePayload(overrides),
        },
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
    const initial = location.state as {
      initialContent?: string;
      initialAttachments?: ChatAttachment[];
    } | null;
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
          <Stack key={message.id} gap="xs">
            <Text fw={message.role === "assistant" ? 400 : 700}>
              {message.content}
            </Text>
            {message.role === "assistant" && (
              <>
                <RetrievalStatusNotice retrieval={message.retrieval} />
                {(message.sources?.length ?? 0) > 0 && (
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed">
                      Sources
                    </Text>
                    {message.sources!.map((source) => (
                      <Anchor
                        key={source.citationId}
                        href={source.url}
                        size="xs"
                      >
                        [{source.citationId}] {source.title || source.pageId}
                      </Anchor>
                    ))}
                  </Stack>
                )}
              </>
            )}
          </Stack>
        ))}
      </Stack>
      <ChatInput
        disabled={busy}
        onSend={(content, _mentions, attachments) => send(content, attachments)}
        onUpload={uploadAttachment}
      />
      <Group gap="xs">
        <Select
          size="xs"
          w={220}
          label="Knowledge scope for new messages"
          placeholder="All spaces"
          clearable
          data={(spacesData?.items ?? []).map((space) => ({
            value: space.id,
            label: space.name,
          }))}
          value={scopeSpaceId}
          onChange={(value) => setScopeSpaceId(value || null)}
        />
        <Button
          size="xs"
          variant={overridesOpen ? "light" : "default"}
          onClick={() => setOverridesOpen((open) => !open)}
        >
          Retrieval overrides
        </Button>
      </Group>
      {overridesOpen && (
        <Stack gap="xs">
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              Per-message overrides; empty fields use chat defaults.
            </Text>
            <Button
              size="compact-xs"
              variant="subtle"
              onClick={() => setOverrides(EMPTY_CHAT_OVERRIDES)}
            >
              Reset
            </Button>
          </Group>
          <Group gap="md">
            <NumberInput
              label="Recall count"
              description="1-50 for chat retrieval."
              min={1}
              max={50}
              step={1}
              w={200}
              value={overrides.recallCount ?? ""}
              onChange={(value) =>
                setOverrides((current) => ({
                  ...current,
                  recallCount: toOptionalInt(value),
                }))
              }
            />
            <NumberInput
              label="Rerank top K"
              description="1-20 for chat retrieval."
              min={1}
              max={20}
              step={1}
              w={200}
              value={overrides.rerankTopK ?? ""}
              onChange={(value) =>
                setOverrides((current) => ({
                  ...current,
                  rerankTopK: toOptionalInt(value),
                }))
              }
            />
          </Group>
          <Slider
            label={(value) => `Vector threshold: ${value}`}
            min={0}
            max={1}
            step={0.01}
            value={overrides.vectorThreshold ?? 0}
            onChange={(value) =>
              setOverrides((current) => ({
                ...current,
                vectorThreshold: value,
              }))
            }
          />
          <Slider
            label={(value) => `Keyword threshold: ${value}`}
            min={0}
            max={1}
            step={0.01}
            value={overrides.keywordThreshold ?? 0}
            onChange={(value) =>
              setOverrides((current) => ({
                ...current,
                keywordThreshold: value,
              }))
            }
          />
          <div>
            <Text size="sm">Rerank model</Text>
            <Text size="xs" c="dimmed">
              Inherit keeps the chat default. Server-resolved clears the
              explicit selection and lets the server pick a configured model.
            </Text>
            <SegmentedControl
              mt={4}
              size="xs"
              data={[
                { value: "inherit", label: "Inherit" },
                { value: "explicit", label: "Custom model" },
                { value: "cleared", label: "Server-resolved" },
              ]}
              value={overrides.rerankModelMode}
              onChange={(value) =>
                setOverrides((current) => ({
                  ...current,
                  rerankModelMode:
                    value === "explicit" || value === "cleared"
                      ? value
                      : "inherit",
                }))
              }
            />
          </div>
          {overrides.rerankModelMode === "explicit" && (
            <TextInput
              label="Model reference"
              description="Authorized model reference; the server validates it."
              w={200}
              value={overrides.rerankModelText}
              onChange={(event) => {
                // React nulls currentTarget once dispatch ends; the queued
                // updater runs later, so the value must be captured here.
                const value = event.currentTarget.value;
                setOverrides((current) => ({
                  ...current,
                  rerankModelText: value,
                }));
              }}
            />
          )}
          <Slider
            label={(value) => `Rerank threshold: ${value}`}
            min={-10}
            max={10}
            step={0.01}
            value={overrides.rerankThreshold ?? 0}
            onChange={(value) =>
              setOverrides((current) => ({
                ...current,
                rerankThreshold: value,
              }))
            }
          />
        </Stack>
      )}
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

function toOptionalInt(value: string | number): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
