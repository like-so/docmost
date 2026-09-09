import {
  Alert,
  Button,
  Card,
  Group,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useEffect, useState } from "react";
import {
  listWorkspaceApiKeys,
  renameWorkspaceApiKey,
  revokeWorkspaceApiKey,
  type ApiKey,
} from "@/features/api-key/services/api-key-service";
import SettingsTitle from "@/components/settings/settings-title";
import useUserRole from "@/hooks/use-user-role";

function ManagedKey({
  apiKey,
  onChanged,
}: {
  apiKey: ApiKey;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(apiKey.name);

  async function rename() {
    await renameWorkspaceApiKey(apiKey.id, name);
    await onChanged();
  }

  async function revoke() {
    await revokeWorkspaceApiKey(apiKey.id);
    await onChanged();
  }

  return (
    <Card withBorder>
      <Group justify="space-between">
        <TextInput
          aria-label={`Name for ${apiKey.name}`}
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Text size="sm" c="dimmed">
          Creator: {apiKey.creatorId}
        </Text>
        <Group>
          <Button
            disabled={!name || name === apiKey.name}
            variant="default"
            onClick={() => void rename()}
          >
            Rename
          </Button>
          <Button color="red" variant="default" onClick={() => void revoke()}>
            Revoke
          </Button>
        </Group>
      </Group>
    </Card>
  );
}

export default function ApiKeyManagement() {
  const { isAdmin } = useUserRole();
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const refresh = async () => setKeys(await listWorkspaceApiKeys());

  useEffect(() => {
    if (isAdmin) void refresh();
  }, [isAdmin]);

  if (!isAdmin)
    return (
      <Alert color="red">
        Only workspace administrators can manage API keys.
      </Alert>
    );

  return (
    <Stack>
      <SettingsTitle title="API management" />
      <Text c="dimmed">Manage API keys created by workspace members.</Text>
      {keys.map((apiKey) => (
        <ManagedKey key={apiKey.id} apiKey={apiKey} onChanged={refresh} />
      ))}
    </Stack>
  );
}
