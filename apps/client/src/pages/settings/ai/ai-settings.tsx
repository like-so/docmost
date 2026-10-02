import {
  Alert,
  Button,
  Card,
  Divider,
  NumberInput,
  PasswordInput,
  Select,
  Slider,
  Stack,
  Switch,
  Text,
  TextInput,
  Title,
  Textarea,
} from "@mantine/core";
import { useEffect, useState } from "react";
import SettingsTitle from "@/components/settings/settings-title";
import {
  getAiProvider,
  getRagRetrievalSettings,
  getRagSettings,
  updateAiControls,
  updateAiProvider,
  updateRagRetrievalSettings,
  updateRagSettings,
  type RagChatRetrievalConfig,
  type RagIndexProfileConfig,
  type RagRetrievalConfig,
  type RagSettingsView,
} from "@/features/ai/services/ai-service";
import { useAtomValue } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom";

type RetrievalForm = RagRetrievalConfig & {
  rerankModelText: string;
};

type ChatForm = Omit<
  RagChatRetrievalConfig,
  "rerankModel" | "queryUnderstandingModel"
> & {
  queryUnderstandingModelText: string;
};

export default function AiSettings() {
  const workspace = useAtomValue(workspaceAtom);
  const [driver, setDriver] = useState("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [chatModel, setChatModel] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);

  const [retrieval, setRetrieval] = useState<RetrievalForm | null>(null);
  const [chat, setChat] = useState<ChatForm | null>(null);
  const [retrievalSaved, setRetrievalSaved] = useState(false);
  const [retrievalError, setRetrievalError] = useState<string>();

  const [ragSettings, setRagSettings] = useState<RagSettingsView | null>(null);
  const [indexing, setIndexing] = useState<RagIndexingStrategyState>({
    vectorEnabled: true,
    keywordEnabled: true,
  });
  const [indexSaved, setIndexSaved] = useState(false);
  const [indexError, setIndexError] = useState<string>();

  useEffect(() => {
    getAiProvider().then((provider) => {
      setDriver(provider.driver || "openai-compatible");
      setBaseUrl(provider.baseUrl || "");
      setChatModel(provider.chatModel || "");
      setEmbeddingModel(provider.embeddingModel || "");
    });
    getRagRetrievalSettings()
      .then((settings) => {
        setRetrieval({
          ...settings.search,
          rerankModelText: settings.search.rerankModel ?? "",
        });
        setChat({
          ...settings.chat,
          queryUnderstandingModelText:
            settings.chat.queryUnderstandingModel ?? "",
        });
      })
      .catch(() => setRetrievalError("Retrieval settings are unavailable."));
    getRagSettings()
      .then((settings) => {
        setRagSettings(settings);
        setIndexing(
          settings.indexProfile?.indexingStrategy ?? {
            vectorEnabled: true,
            keywordEnabled: true,
          },
        );
      })
      .catch(() => setIndexError("Index configuration is unavailable."));
  }, []);

  const save = async () => {
    await updateAiProvider({
      driver,
      baseUrl,
      chatModel,
      embeddingModel: embeddingModel || undefined,
      apiKey: apiKey || undefined,
    });
    setApiKey("");
    setSaved(true);
  };

  const saveRetrieval = async () => {
    if (!retrieval || !chat) return;
    setRetrievalError(undefined);
    try {
      const view = await updateRagRetrievalSettings({
        search: {
          recallCount: retrieval.recallCount,
          vectorThreshold: retrieval.vectorThreshold,
          keywordThreshold: retrieval.keywordThreshold,
          rerankModel: retrieval.rerankModelText.trim() || null,
          rerankTopK: retrieval.rerankTopK,
          rerankThreshold: retrieval.rerankThreshold,
        },
        chat: {
          rewriteEnabled: chat.rewriteEnabled,
          expansionEnabled: chat.expansionEnabled,
          queryUnderstandingModel:
            chat.queryUnderstandingModelText.trim() || null,
          rewriteSystemPrompt: chat.rewriteSystemPrompt,
          rewriteUserPrompt: chat.rewriteUserPrompt,
        },
      });
      setRetrieval({
        ...view.search,
        rerankModelText: view.search.rerankModel ?? "",
      });
      setChat({
        ...view.chat,
        queryUnderstandingModelText: view.chat.queryUnderstandingModel ?? "",
      });
      setRetrievalSaved(true);
    } catch {
      setRetrievalError(
        "Retrieval settings were rejected. Check the configured values.",
      );
    }
  };

  const saveIndexing = async () => {
    if (!ragSettings?.indexProfile) return;
    setIndexError(undefined);
    try {
      const {
        profileId: _profileId,
        profileHash: _profileHash,
        ...config
      } = ragSettings.indexProfile;
      const view = await updateRagSettings({
        enabled: ragSettings.enabled,
        indexProfileConfig: {
          ...config,
          indexingStrategy: indexing,
        },
      });
      setRagSettings(view);
      setIndexing(
        view.indexProfile?.indexingStrategy ?? {
          vectorEnabled: true,
          keywordEnabled: true,
        },
      );
      setIndexSaved(true);
    } catch {
      setIndexError(
        "Index configuration was rejected. At least one channel must stay enabled.",
      );
    }
  };

  const strategyChanged =
    !ragSettings?.indexProfile ||
    (ragSettings.indexProfile.indexingStrategy?.vectorEnabled ?? true) !==
      indexing.vectorEnabled ||
    (ragSettings.indexProfile.indexingStrategy?.keywordEnabled ?? true) !==
      indexing.keywordEnabled;

  return (
    <Stack>
      <SettingsTitle title="AI" />
      <Card withBorder>
        <Stack>
          <Select
            label="Provider"
            value={driver}
            onChange={(value) => setDriver(value || "openai-compatible")}
            data={["openai", "openai-compatible", "gemini", "ollama"]}
          />
          <TextInput
            label="Provider base URL"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.currentTarget.value)}
          />
          <TextInput
            label="Chat model"
            value={chatModel}
            onChange={(event) => setChatModel(event.currentTarget.value)}
          />
          <TextInput
            label="Embedding model"
            value={embeddingModel}
            onChange={(event) => setEmbeddingModel(event.currentTarget.value)}
          />
          <PasswordInput
            label="API key"
            description="Stored encrypted and never shown again."
            value={apiKey}
            onChange={(event) => setApiKey(event.currentTarget.value)}
          />
          <Switch
            label="AI Answers search"
            checked={workspace?.settings?.ai?.search === true}
            onChange={(event) =>
              updateAiControls({ aiSearch: event.currentTarget.checked })
            }
          />
          <Switch
            label="Ask AI"
            checked={workspace?.settings?.ai?.generative === true}
            onChange={(event) =>
              updateAiControls({ generativeAi: event.currentTarget.checked })
            }
          />
          <Switch
            label="AI Chat"
            checked={workspace?.settings?.ai?.chat === true}
            onChange={(event) =>
              updateAiControls({ aiChat: event.currentTarget.checked })
            }
          />
          <Switch
            label="Read-only chat"
            checked={workspace?.settings?.ai?.chatReadOnly === true}
            onChange={(event) =>
              updateAiControls({ aiChatReadOnly: event.currentTarget.checked })
            }
          />
          <Switch
            label="Use workspace knowledge only"
            checked={
              workspace?.settings?.ai?.chatWorkspaceKnowledgeOnly === true
            }
            onChange={(event) =>
              updateAiControls({
                aiChatWorkspaceKnowledgeOnly: event.currentTarget.checked,
              })
            }
          />
          <Switch
            label="MCP"
            checked={workspace?.settings?.ai?.mcp === true}
            onChange={(event) =>
              updateAiControls({ mcpEnabled: event.currentTarget.checked })
            }
          />
          <Switch
            label="Require OAuth for MCP"
            description="Reject browser sessions and API keys for MCP requests."
            checked={workspace?.settings?.ai?.enforceMcpOauth === true}
            disabled={workspace?.settings?.ai?.mcp !== true}
            onChange={(event) =>
              updateAiControls({ enforceMcpOauth: event.currentTarget.checked })
            }
          />
          <Button onClick={save} disabled={!baseUrl || !chatModel}>
            Save provider
          </Button>
          {saved && <Alert color="green">Provider saved.</Alert>}
        </Stack>
      </Card>
      {retrieval && chat && (
        <Card withBorder>
          <Title order={2}>Search retrieval</Title>
          <Text c="dimmed" size="sm">
            Query-time settings only. Saving them never reindexes sources.
          </Text>
          <Stack mt="sm">
            <NumberInput
              label="Recall count"
              description="Candidates recalled per channel before fusion (1-100)."
              min={1}
              max={100}
              step={1}
              value={retrieval.recallCount}
              onChange={(value) =>
                setRetrieval((current) =>
                  current
                    ? {
                        ...current,
                        recallCount: toInt(value, current.recallCount),
                      }
                    : current,
                )
              }
            />
            <Slider
              label={(value) => `Vector threshold: ${value}`}
              min={0}
              max={1}
              step={0.05}
              value={retrieval.vectorThreshold}
              onChange={(value) =>
                setRetrieval((current) =>
                  current ? { ...current, vectorThreshold: value } : current,
                )
              }
            />
            <Slider
              label={(value) => `Keyword threshold: ${value}`}
              min={0}
              max={1}
              step={0.05}
              value={retrieval.keywordThreshold}
              onChange={(value) =>
                setRetrieval((current) =>
                  current ? { ...current, keywordThreshold: value } : current,
                )
              }
            />
            <TextInput
              label="Rerank model"
              description="Leave empty to disable reranking; results keep the fusion order with a visible notice."
              value={retrieval.rerankModelText}
              onChange={(event) =>
                setRetrieval((current) =>
                  current
                    ? { ...current, rerankModelText: event.currentTarget.value }
                    : current,
                )
              }
            />
            <NumberInput
              label="Rerank top K"
              description="Maximum results kept after reranking (1-100)."
              min={1}
              max={100}
              step={1}
              value={retrieval.rerankTopK}
              onChange={(value) =>
                setRetrieval((current) =>
                  current
                    ? {
                        ...current,
                        rerankTopK: toInt(value, current.rerankTopK),
                      }
                    : current,
                )
              }
            />
            <div>
              <Text size="sm" c="dimmed">
                Minimum rerank relevance score (-10 to 10).
              </Text>
              <Slider
                label={(value) => `Rerank threshold: ${value}`}
                min={-10}
                max={10}
                step={0.1}
                value={retrieval.rerankThreshold}
                onChange={(value) =>
                  setRetrieval((current) =>
                    current ? { ...current, rerankThreshold: value } : current,
                  )
                }
              />
            </div>
          </Stack>
          <Divider my="md" />
          <Title order={2}>Chat retrieval defaults</Title>
          <Stack mt="sm">
            <Switch
              label="Rewrite follow-up questions with conversation history"
              checked={chat.rewriteEnabled}
              onChange={(event) =>
                setChat((current) =>
                  current
                    ? {
                        ...current,
                        rewriteEnabled: event.currentTarget.checked,
                      }
                    : current,
                )
              }
            />
            <Switch
              label="Expand queries into alternative phrasings"
              checked={chat.expansionEnabled}
              onChange={(event) =>
                setChat((current) =>
                  current
                    ? {
                        ...current,
                        expansionEnabled: event.currentTarget.checked,
                      }
                    : current,
                )
              }
            />
            <TextInput
              label="Query understanding model"
              description="Empty uses the workspace chat model."
              value={chat.queryUnderstandingModelText}
              onChange={(event) =>
                setChat((current) =>
                  current
                    ? {
                        ...current,
                        queryUnderstandingModelText: event.currentTarget.value,
                      }
                    : current,
                )
              }
            />
            <Textarea
              label="Rewrite system prompt"
              description="Empty uses the built-in default prompt."
              minRows={3}
              value={chat.rewriteSystemPrompt}
              onChange={(event) =>
                setChat((current) =>
                  current
                    ? {
                        ...current,
                        rewriteSystemPrompt: event.currentTarget.value,
                      }
                    : current,
                )
              }
            />
            <Textarea
              label="Rewrite user prompt"
              minRows={3}
              value={chat.rewriteUserPrompt}
              onChange={(event) =>
                setChat((current) =>
                  current
                    ? {
                        ...current,
                        rewriteUserPrompt: event.currentTarget.value,
                      }
                    : current,
                )
              }
            />
          </Stack>
          <Button mt="md" onClick={saveRetrieval}>
            Save retrieval settings
          </Button>
          {retrievalSaved && (
            <Alert color="green" mt="sm">
              Retrieval settings saved.
            </Alert>
          )}
          {retrievalError && (
            <Alert color="red" mt="sm">
              {retrievalError}
            </Alert>
          )}
        </Card>
      )}
      <Card withBorder>
        <Title order={2}>Index configuration</Title>
        <Text c="dimmed" size="sm">
          Changing indexing channels rebuilds the affected sources. Retrieval
          settings above are query-time only and never trigger a rebuild.
        </Text>
        {ragSettings?.indexProfile ? (
          <Stack mt="sm">
            <Switch
              label="Workspace knowledge indexing enabled"
              checked={ragSettings.enabled}
              onChange={(event) =>
                setRagSettings((current) =>
                  current
                    ? { ...current, enabled: event.currentTarget.checked }
                    : current,
                )
              }
            />
            <Text size="sm">
              Embedding model:{" "}
              <code>{ragSettings.indexProfile.embedding.model}</code> (
              {ragSettings.indexProfile.embedding.dimensions} dimensions) |
              Chunk tokens:{" "}
              <code>{ragSettings.indexProfile.maxChunkTokens}</code> | Overlap
              tokens: <code>{ragSettings.indexProfile.overlapTokens}</code>
            </Text>
            <Switch
              label="Vector channel (semantic recall)"
              checked={indexing.vectorEnabled}
              onChange={(event) =>
                setIndexing((current) => ({
                  ...current,
                  vectorEnabled: event.currentTarget.checked,
                }))
              }
            />
            <Switch
              label="Keyword channel (full-text recall)"
              checked={indexing.keywordEnabled}
              onChange={(event) =>
                setIndexing((current) => ({
                  ...current,
                  keywordEnabled: event.currentTarget.checked,
                }))
              }
            />
            <Button
              onClick={saveIndexing}
              disabled={!indexing.vectorEnabled && !indexing.keywordEnabled}
            >
              Save index configuration
            </Button>
            {strategyChanged && (
              <Alert color="yellow">
                Channel changes trigger a reindex of affected sources.
              </Alert>
            )}
            {indexSaved && (
              <Alert color="green">Index configuration saved.</Alert>
            )}
            {indexError && <Alert color="red">{indexError}</Alert>}
          </Stack>
        ) : (
          <Text c="dimmed" size="sm" mt="sm">
            Workspace knowledge indexing is not configured yet.
          </Text>
        )}
        {indexError && !ragSettings?.indexProfile && (
          <Alert color="red" mt="sm">
            {indexError}
          </Alert>
        )}
      </Card>
    </Stack>
  );
}

function toInt(value: string | number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

type RagIndexingStrategyState = {
  vectorEnabled: boolean;
  keywordEnabled: boolean;
};
