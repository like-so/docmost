import { Button, Card, Group, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import {
  deleteOAuthClient,
  listOAuthClients,
  type OAuthClient,
} from "@/features/oauth/services/oauth-service";
import SettingsTitle from "@/components/settings/settings-title";

export default function OAuthClients() {
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const refresh = () => listOAuthClients().then(setClients);
  useEffect(() => {
    refresh();
  }, []);
  async function remove(id: string) {
    await deleteOAuthClient(id);
    await refresh();
  }
  return (
    <Stack>
      <SettingsTitle title="OAuth clients" />
      {clients.map((client) => (
        <Card key={client.id} withBorder>
          <Group justify="space-between">
            <Text>{client.name}</Text>
            <Button variant="default" onClick={() => remove(client.id)}>
              Delete
            </Button>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}
