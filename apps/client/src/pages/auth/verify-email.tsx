import { Alert, Button, Paper, Stack, Text, Title } from "@mantine/core";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { verifyUserToken } from "@/features/auth/services/auth-service.ts";

export default function VerifyEmail() {
  const [params] = useSearchParams();
  const [error, setError] = useState<string>();
  const token = params.get("token");
  const type = params.get("type") ?? "email-verification";

  useEffect(() => {
    if (!token) return;
    verifyUserToken({ token, type }).catch(() => {
      setError("This verification link is invalid or has expired.");
    });
  }, [token, type]);

  return (
    <Paper maw={440} mx="auto" mt="xl" p="xl" withBorder>
      <Stack>
        <Title order={1} size="h3">Verify email</Title>
        {error ? (
          <Alert color="red">{error}</Alert>
        ) : token ? (
          <Text>Your email verification link has been confirmed.</Text>
        ) : (
          <Alert color="red">A verification token is required.</Alert>
        )}
        <Button component={Link} to="/login">Return to login</Button>
      </Stack>
    </Paper>
  );
}
