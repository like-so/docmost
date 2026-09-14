import {
  Button,
  Card,
  Checkbox,
  Group,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useEffect, useState } from "react";
import {
  createApiKey,
  listApiKeys,
  renameApiKey,
  revokeApiKey,
  type ApiKey,
} from "@/features/api-key/services/api-key-service";
import SettingsTitle from "@/components/settings/settings-title";

function getDefaultExpiration() {
  const date = new Date();
  date.setDate(date.getDate() + 90);
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 16);
}

function PersonalKey({
  apiKey,
  onChanged,
}: {
  apiKey: ApiKey;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(apiKey.name);

  async function rename() {
    await renameApiKey(apiKey.id, name);
    await onChanged();
  }

  async function revoke() {
    await revokeApiKey(apiKey.id);
    await onChanged();
  }

  return (
    <Group justify="space-between">
      <TextInput
        aria-label={`Name for ${apiKey.name}`}
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
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
  );
}

export default function ApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [expiresAt, setExpiresAt] = useState(getDefaultExpiration);
  const [token, setToken] = useState<string>();
  const refresh = async () => setKeys(await listApiKeys());

  useEffect(() => {
    let cancelled = false;
    listApiKeys().then((result) => {
      if (!cancelled) setKeys(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function create() {
    const result = await createApiKey(name, scopes, expiresAt || undefined);
    setToken(result.token);
    setName("");
    setScopes(["read"]);
    setExpiresAt(getDefaultExpiration());
    await refresh();
  }

  return (
    <Stack>
      <SettingsTitle title="API keys" />
      <Card withBorder>
        <TextInput
          label="Name"
          value={name}
          onChange={(event) => setName(event.currentTarget.value)}
        />
        <Checkbox.Group
          label="Scopes"
          value={scopes}
          onChange={setScopes}
          mt="md"
        >
          <Group mt="xs">
            <Checkbox value="read" label="Read" />
            <Checkbox value="write" label="Write" />
            <Checkbox value="admin" label="Admin" />
          </Group>
        </Checkbox.Group>
        <TextInput
          label="Expires at"
          type="datetime-local"
          value={expiresAt}
          onChange={(event) => setExpiresAt(event.currentTarget.value)}
          mt="md"
        />
        <Group mt="md">
          <Button
            disabled={!name || !scopes.length}
            onClick={() => void create()}
          >
            Create key
          </Button>
        </Group>
        {token && <Text mt="md">Copy this key now: {token}</Text>}
        <Stack mt="md">
          {keys.map((apiKey) => (
            <PersonalKey key={apiKey.id} apiKey={apiKey} onChanged={refresh} />
          ))}
        </Stack>
      </Card>
    </Stack>
  );
}
