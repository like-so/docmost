import { Button, Card, Group, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import {
  listOAuthGrants,
  revokeOAuthGrant,
  type OAuthGrant,
} from "@/features/oauth/services/oauth-service";
import SettingsTitle from "@/components/settings/settings-title";

export default function AuthorizedApps() {
  const [grants, setGrants] = useState<OAuthGrant[]>([]);
  const refresh = () => listOAuthGrants().then(setGrants);
  useEffect(() => {
    refresh();
  }, []);
  async function revoke(id: string) {
    await revokeOAuthGrant(id);
    await refresh();
  }
  return (
    <Stack>
      <SettingsTitle title="Authorized applications" />
      {grants.map((grant) => (
        <Card key={grant.id} withBorder>
          <Group justify="space-between">
            <Text>{grant.name}</Text>
            <Button variant="default" onClick={() => revoke(grant.id)}>
              Revoke
            </Button>
          </Group>
        </Card>
      ))}
    </Stack>
  );
}
