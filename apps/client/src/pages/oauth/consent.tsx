import { Button, Card, Group, Stack, Text } from "@mantine/core";
import { useSearchParams } from "react-router-dom";
import { confirmOAuthAuthorization } from "@/features/oauth/services/oauth-service";

export default function OAuthConsent() {
  const [params] = useSearchParams();
  const authorize = async (decision: "allow" | "deny") => {
    const transaction = params.get("transaction");
    const csrf = params.get("csrf");
    if (!transaction || !csrf) return;
    const result = await confirmOAuthAuthorization(transaction, csrf, decision);
    window.location.assign(result.redirectUri);
  };
  return (
    <Stack align="center" mt="xl">
      <Card withBorder>
        <Text fw={600}>Authorize application</Text>
        <Text mt="sm">
          This application requests: {params.get("scope") || "no access"}
        </Text>
        <Group mt="md">
          <Button onClick={() => authorize("allow")}>Allow</Button>
          <Button variant="default" onClick={() => authorize("deny")}>
            Deny
          </Button>
        </Group>
      </Card>
    </Stack>
  );
}
