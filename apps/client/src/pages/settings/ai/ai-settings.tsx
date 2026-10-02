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
  type RagIndexProfile,
  type RagIndexingStrategy,
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
  rerankModelText: string;
  queryUnderstandingModelText: string;
};

type IndexProfileForm = {
  parserVersion: string;
  chunkerVersion: string;
  maxChunkTokens: number;
  overlapTokens: number;
  requiredMimeTypesText: string;
  imageInterpretation: "disabled" | "required";
  embeddingModel: string;
  embeddingDimensions: number | null;
  embeddingTokenizerIdText: string;
  embeddingMaxInputTokens: number | null;
};

const DEFAULT_INDEX_PROFILE_FORM: IndexProfileForm = {
  parserVersion: "v1",
  chunkerVersion: "v1",
  maxChunkTokens: 512,
  overlapTokens: 64,
  requiredMimeTypesText: "",
  imageInterpretation: "disabled",
  embeddingModel: "",
  embeddingDimensions: null,
  embeddingTokenizerIdText: "",
  embeddingMaxInputTokens: null,
};

function indexProfileFormFromProfile(
  profile: RagIndexProfile,
): IndexProfileForm {
  return {
    parserVersion: profile.parserVersion,
    chunkerVersion: profile.chunkerVersion,
    maxChunkTokens: profile.maxChunkTokens,
    overlapTokens: profile.overlapTokens,
    requiredMimeTypesText: profile.sourcePolicy.requiredMimeTypes.join(", "),
    imageInterpretation: profile.sourcePolicy.imageInterpretation,
    embeddingModel: profile.embedding.model,
    embeddingDimensions: profile.embedding.dimensions,
    embeddingTokenizerIdText: profile.embedding.tokenizerId ?? "",
    embeddingMaxInputTokens: profile.embedding.maxInputTokens,
  };
}

function indexProfileConfigFromForm(form: IndexProfileForm) {
  return {
    parserVersion: form.parserVersion.trim(),
    chunkerVersion: form.chunkerVersion.trim(),
    maxChunkTokens: form.maxChunkTokens,
    overlapTokens: form.overlapTokens,
    sourcePolicy: {
      requiredMimeTypes: form.requiredMimeTypesText
        .split(",")
        .map((mimeType) => mimeType.trim())
        .filter(Boolean),
      imageInterpretation: form.imageInterpretation,
    },
    embedding: {
      driver: "openai-compatible",
      endpointIdentity: null,
      model: form.embeddingModel.trim(),
      dimensions: form.embeddingDimensions,
      tokenizerId: form.embeddingTokenizerIdText.trim() || null,
      maxInputTokens: form.embeddingMaxInputTokens,
    },
  };
}

function isIndexProfileFormComplete(form: IndexProfileForm): boolean {
  const config = indexProfileConfigFromForm(form);
  return (
    config.parserVersion.length > 0 &&
    config.chunkerVersion.length > 0 &&
    Number.isSafeInteger(config.maxChunkTokens) &&
    config.maxChunkTokens > 0 &&
    Number.isSafeInteger(config.overlapTokens) &&
    config.overlapTokens >= 0 &&
    config.overlapTokens < config.maxChunkTokens &&
    config.embedding.model.length > 0 &&
    Number.isSafeInteger(config.embedding.dimensions) &&
    config.embedding.dimensions > 0 &&
    Number.isSafeInteger(config.embedding.maxInputTokens) &&
    config.embedding.maxInputTokens > 0
  );
}

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
  const [retrievalLoadError, setRetrievalLoadError] = useState<string>();

  const [ragSettings, setRagSettings] = useState<RagSettingsView | null>(null);
  const [profileFormBase, setProfileForm] = useState<IndexProfileForm>(
    DEFAULT_INDEX_PROFILE_FORM,
  );
  // A new workspace must be able to create its profile from the UI; prefill
  // the model name from provider settings. Dimensions and token limits stay
  // owner-supplied, never guessed.
  const profileForm =
    !ragSettings?.indexProfile &&
    !profileFormBase.embeddingModel &&
    embeddingModel
      ? { ...profileFormBase, embeddingModel }
      : profileFormBase;
  const [indexing, setIndexing] = useState<RagIndexingStrategy>({
    vectorEnabled: true,
    keywordEnabled: true,
  });
  const [indexSaved, setIndexSaved] = useState(false);
  const [indexError, setIndexError] = useState<string>();
  const [indexLoadError, setIndexLoadError] = useState<string>();

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
          rerankModelText: settings.chat.rerankModel ?? "",
          queryUnderstandingModelText:
            settings.chat.queryUnderstandingModel ?? "",
        });
      })
      .catch((error) => {
        setRetrievalLoadError(loadErrorMessage(error));
      });
    getRagSettings()
      .then((settings) => {
        setRagSettings(settings);
        setIndexing(
          settings.indexProfile?.indexingStrategy ?? {
            vectorEnabled: true,
            keywordEnabled: true,
          },
        );
        if (settings.indexProfile) {
          setProfileForm(indexProfileFormFromProfile(settings.indexProfile));
        }
      })
      .catch((error) => {
        setIndexLoadError(loadErrorMessage(error));
      });
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
          recallCount: chat.recallCount,
          vectorThreshold: chat.vectorThreshold,
          keywordThreshold: chat.keywordThreshold,
          rerankModel: chat.rerankModelText.trim() || null,
          rerankTopK: chat.rerankTopK,
          rerankThreshold: chat.rerankThreshold,
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
        rerankModelText: view.chat.rerankModel ?? "",
        queryUnderstandingModelText: view.chat.queryUnderstandingModel ?? "",
      });
      setRetrievalSaved(true);
    } catch (error) {
      setRetrievalError(saveErrorMessage(error));
    }
  };

  const saveIndexing = async () => {
    setIndexError(undefined);
    if (!isIndexProfileFormComplete(profileForm)) return;
    try {
      const view = await updateRagSettings({
        enabled: ragSettings?.enabled ?? true,
        indexProfileConfig: {
          ...indexProfileConfigFromForm(profileForm),
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
      if (view.indexProfile) {
        setProfileForm(indexProfileFormFromProfile(view.indexProfile));
      }
      setIndexSaved(true);
    } catch (error) {
      setIndexError(saveErrorMessage(error));
    }
  };

  const profileComplete = isIndexProfileFormComplete(profileForm);
  const strategyChanged =
    (ragSettings?.indexProfile?.indexingStrategy?.vectorEnabled ?? true) !==
      indexing.vectorEnabled ||
    (ragSettings?.indexProfile?.indexingStrategy?.keywordEnabled ?? true) !==
      indexing.keywordEnabled;
  const profileChanged = (() => {
    if (!ragSettings?.indexProfile) return true;
    const original = indexProfileFormFromProfile(ragSettings.indexProfile);
    return JSON.stringify(original) !== JSON.stringify(profileForm);
  })();
  const reindexWarning = Boolean(
    ragSettings?.indexProfile && (profileChanged || strategyChanged),
  );

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
      {retrievalLoadError && (
        <Alert color="red" role="alert">
          {retrievalLoadError}
        </Alert>
      )}
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
              description="Without a configured rerank model, results keep the fusion order and search reports reranking as not configured."
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
          <Text c="dimmed" size="sm">
            Independent chat flow defaults. Ranges follow the chat retrieval
            reference, not the workspace search ranges.
          </Text>
          <Stack mt="sm">
            <NumberInput
              label="Chat recall count"
              description="Candidates recalled per channel for chat answers (1-50)."
              min={1}
              max={50}
              step={1}
              value={chat.recallCount}
              onChange={(value) =>
                setChat((current) =>
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
              label={(value) => `Chat vector threshold: ${value}`}
              min={0}
              max={1}
              step={0.01}
              value={chat.vectorThreshold}
              onChange={(value) =>
                setChat((current) =>
                  current ? { ...current, vectorThreshold: value } : current,
                )
              }
            />
            <Slider
              label={(value) => `Chat keyword threshold: ${value}`}
              min={0}
              max={1}
              step={0.01}
              value={chat.keywordThreshold}
              onChange={(value) =>
                setChat((current) =>
                  current ? { ...current, keywordThreshold: value } : current,
                )
              }
            />
            <TextInput
              label="Chat rerank model"
              description="Without a configured chat rerank model, chat answers report reranking as not configured."
              value={chat.rerankModelText}
              onChange={(event) =>
                setChat((current) =>
                  current
                    ? { ...current, rerankModelText: event.currentTarget.value }
                    : current,
                )
              }
            />
            <NumberInput
              label="Chat rerank top K"
              description="Maximum chat evidence kept after reranking (1-20)."
              min={1}
              max={20}
              step={1}
              value={chat.rerankTopK}
              onChange={(value) =>
                setChat((current) =>
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
                Minimum chat rerank relevance score (-10 to 10).
              </Text>
              <Slider
                label={(value) => `Chat rerank threshold: ${value}`}
                min={-10}
                max={10}
                step={0.01}
                value={chat.rerankThreshold}
                onChange={(value) =>
                  setChat((current) =>
                    current ? { ...current, rerankThreshold: value } : current,
                  )
                }
              />
            </div>
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
      {indexLoadError && (
        <Alert color="red" role="alert">
          {indexLoadError}
        </Alert>
      )}
      <Card withBorder>
        <Title order={2}>Index configuration</Title>
        <Text c="dimmed" size="sm">
          Index profile changes rebuild the affected sources. Retrieval settings
          above are query-time only and never trigger a rebuild.
        </Text>
        <Stack mt="sm">
          <Switch
            label="Workspace knowledge indexing enabled"
            checked={ragSettings?.enabled ?? false}
            onChange={(event) =>
              setRagSettings((current) =>
                current
                  ? { ...current, enabled: event.currentTarget.checked }
                  : current,
              )
            }
          />
          <NumberInput
            label="Chunk size (tokens)"
            description="Maximum source tokens per chunk; must fit inside the model input limit."
            min={1}
            step={1}
            value={profileForm.maxChunkTokens}
            onChange={(value) =>
              setProfileForm((current) => ({
                ...current,
                maxChunkTokens: toInt(value, current.maxChunkTokens),
              }))
            }
          />
          <NumberInput
            label="Chunk overlap (tokens)"
            description="Source tokens shared between consecutive chunks (0 or more, below the chunk size)."
            min={0}
            step={1}
            value={profileForm.overlapTokens}
            onChange={(value) =>
              setProfileForm((current) => ({
                ...current,
                overlapTokens: toInt(value, current.overlapTokens),
              }))
            }
          />
          <TextInput
            label="Index embedding model"
            description="Embeddings run through the openai-compatible provider configured above."
            value={profileForm.embeddingModel}
            onChange={(event) =>
              setProfileForm((current) => ({
                ...current,
                embeddingModel: event.currentTarget.value,
              }))
            }
          />
          <NumberInput
            label="Embedding dimensions"
            description="Exact output dimension of the model. Required; the server never guesses it."
            min={1}
            step={1}
            value={profileForm.embeddingDimensions ?? ""}
            onChange={(value) =>
              setProfileForm((current) => ({
                ...current,
                embeddingDimensions: toOptionalInt(value),
              }))
            }
          />
          <NumberInput
            label="Embedding max input tokens"
            description="Verified model input limit used to bound chunk budgets. Required."
            min={1}
            step={1}
            value={profileForm.embeddingMaxInputTokens ?? ""}
            onChange={(value) =>
              setProfileForm((current) => ({
                ...current,
                embeddingMaxInputTokens: toOptionalInt(value),
              }))
            }
          />
          <TextInput
            label="Embedding tokenizer"
            description="Optional tokenizer identifier; empty uses the model default."
            value={profileForm.embeddingTokenizerIdText}
            onChange={(event) =>
              setProfileForm((current) => ({
                ...current,
                embeddingTokenizerIdText: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="Parser version"
            description="Pipeline identity for document parsing; changing it reindexes sources."
            value={profileForm.parserVersion}
            onChange={(event) =>
              setProfileForm((current) => ({
                ...current,
                parserVersion: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="Chunker version"
            description="Pipeline identity for chunking; changing it reindexes sources."
            value={profileForm.chunkerVersion}
            onChange={(event) =>
              setProfileForm((current) => ({
                ...current,
                chunkerVersion: event.currentTarget.value,
              }))
            }
          />
          <TextInput
            label="Required MIME types"
            description="Comma-separated MIME types parsed with image interpretation."
            value={profileForm.requiredMimeTypesText}
            onChange={(event) =>
              setProfileForm((current) => ({
                ...current,
                requiredMimeTypesText: event.currentTarget.value,
              }))
            }
          />
          <Select
            label="Image interpretation"
            value={profileForm.imageInterpretation}
            onChange={(value) =>
              setProfileForm((current) => ({
                ...current,
                imageInterpretation:
                  value === "required" ? "required" : "disabled",
              }))
            }
            data={[
              { value: "disabled", label: "Disabled" },
              { value: "required", label: "Required" },
            ]}
          />
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
            disabled={
              !profileComplete ||
              (!indexing.vectorEnabled && !indexing.keywordEnabled)
            }
          >
            {ragSettings?.indexProfile
              ? "Save index configuration"
              : "Create index profile"}
          </Button>
          {reindexWarning && (
            <Alert color="yellow">
              Index changes trigger a reindex of affected sources.
            </Alert>
          )}
          {indexSaved && (
            <Alert color="green">Index configuration saved.</Alert>
          )}
          {indexError && <Alert color="red">{indexError}</Alert>}
        </Stack>
      </Card>
    </Stack>
  );
}

function toInt(value: string | number, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toOptionalInt(value: string | number): number | null {
  if (value === "" || value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function isDeniedError(error: unknown): boolean {
  const status = (error as { response?: { status?: number } } | undefined)
    ?.response?.status;
  return status === 403;
}

function loadErrorMessage(error: unknown): string {
  return isDeniedError(error)
    ? "Owner access is required to view these settings."
    : "These settings are unavailable. Check your connection and reload.";
}

function saveErrorMessage(error: unknown): string {
  return isDeniedError(error)
    ? "Owner access is required to change these settings."
    : "The settings were rejected. Check the configured values.";
}
