import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Group,
  Stack,
  Text,
  TextInput,
  PasswordInput,
} from "@mantine/core";
import { useState } from "react";
import { DocumentTitle } from "@/components/ui/document-title.tsx";
import SettingsTitle from "@/components/settings/settings-title.tsx";
import api from "@/lib/api-client.ts";
import useUserRole from "@/hooks/use-user-role.tsx";

type AuditEntry = {
  id: string;
  event: string;
  resourceType: string;
  createdAt: string;
  actorId: string | null;
};

type Destination = {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  status: string;
};

export default function AuditSettings() {
  const { isOwner } = useUserRole();
  const audit = useQuery({
    queryKey: ["audit"],
    queryFn: async () =>
      (await api.post<AuditEntry[]>("/security/audit/list")).data,
    enabled: isOwner,
  });
  const destinations = useQuery({
    queryKey: ["siem-destinations"],
    queryFn: async () =>
      (await api.post<Destination[]>("/security/siem/list")).data,
    enabled: isOwner,
  });
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");

  async function createDestination() {
    await api.post("/security/siem/create", {
      name,
      type: "webhook",
      config: { url },
      secrets: token ? { token } : undefined,
    });
    setName("");
    setUrl("");
    setToken("");
    await destinations.refetch();
  }

  async function removeDestination(id: string) {
    await api.post("/security/siem/delete", { id });
    await destinations.refetch();
  }

  if (!isOwner)
    return (
      <Alert color="red">Only workspace owners can view audit logs.</Alert>
    );

  return (
    <>
      <DocumentTitle title="Audit logs" />
      <SettingsTitle title="Audit logs & SIEM" />
      <Stack gap="md">
        <Text c="dimmed">
          Audit events are retained by your self-hosted deployment policy.
        </Text>
        {audit.data?.map((entry) => (
          <Card key={entry.id} withBorder>
            <Group justify="space-between">
              <Text fw={500}>{entry.event}</Text>
              <Text size="sm" c="dimmed">
                {new Date(entry.createdAt).toLocaleString()}
              </Text>
            </Group>
            <Text size="sm" c="dimmed">
              {entry.resourceType}
              {entry.actorId ? ` · ${entry.actorId}` : ""}
            </Text>
          </Card>
        ))}
        {audit.isError && <Alert color="red">Unable to load audit logs.</Alert>}
        <Text fw={600}>SIEM destinations</Text>
        <Card withBorder>
          <Stack gap="sm">
            <TextInput
              label="Name"
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <PasswordInput
              label="Bearer token"
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
            />
            <TextInput
              label="HTTPS endpoint"
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
            />
            <Button
              disabled={!name || !url}
              onClick={() => void createDestination()}
            >
              Add destination
            </Button>
          </Stack>
        </Card>
        {destinations.data?.map((destination) => (
          <Card key={destination.id} withBorder>
            <Group justify="space-between">
              <Text>{destination.name}</Text>
              <Button
                color="red"
                variant="subtle"
                onClick={() => void removeDestination(destination.id)}
              >
                Remove
              </Button>
            </Group>
            <Text size="sm" c="dimmed">
              {destination.type} · {destination.status}
            </Text>
          </Card>
        ))}
        {destinations.isError && (
          <Alert color="red">Unable to load SIEM destinations.</Alert>
        )}
      </Stack>
    </>
  );
}
