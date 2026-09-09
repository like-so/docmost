import { useQuery } from "@tanstack/react-query";
import { Alert, Button, Card, Stack, Text, Title } from "@mantine/core";
import { useNavigate } from "react-router-dom";
import { getPersonalSpace } from "@/features/personal-space/services/personal-space-service";
import { getSpaceUrl } from "@/lib/config";

export default function PersonalSpacePage() {
  const navigate = useNavigate();
  const personal = useQuery({
    queryKey: ["personal-space"],
    queryFn: getPersonalSpace,
  });

  return (
    <Stack maw={640} mx="auto" p="md">
      <Title order={1}>Personal space</Title>
      <Card withBorder>
        <Stack>
          <Text>Your personal space is visible only to you.</Text>
          {personal.data && <Text fw={600}>{personal.data.name}</Text>}
          <Button
            disabled={!personal.data}
            onClick={() => navigate(getSpaceUrl(personal.data!.slug))}
          >
            Open personal space
          </Button>
        </Stack>
      </Card>
      {personal.isError && (
        <Alert color="red">
          Personal spaces are unavailable in this workspace.
        </Alert>
      )}
    </Stack>
  );
}
