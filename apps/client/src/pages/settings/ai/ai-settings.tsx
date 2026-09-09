import {
  Alert,
  Button,
  Card,
  PasswordInput,
  Select,
  Stack,
  Switch,
  TextInput,
} from "@mantine/core";
import { useEffect, useState } from "react";
import SettingsTitle from "@/components/settings/settings-title";
import {
  getAiProvider,
  updateAiControls,
  updateAiProvider,
} from "@/features/ai/services/ai-service";
import { useAtomValue } from "jotai";
import { workspaceAtom } from "@/features/user/atoms/current-user-atom";

export default function AiSettings() {
  const workspace = useAtomValue(workspaceAtom);
  const [driver, setDriver] = useState("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [chatModel, setChatModel] = useState("");
  const [embeddingModel, setEmbeddingModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    getAiProvider().then((provider) => {
      setDriver(provider.driver || "openai-compatible");
      setBaseUrl(provider.baseUrl || "");
      setChatModel(provider.chatModel || "");
      setEmbeddingModel(provider.embeddingModel || "");
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
            checked={workspace?.settings?.ai?.chatWorkspaceKnowledgeOnly === true}
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
    </Stack>
  );
}
