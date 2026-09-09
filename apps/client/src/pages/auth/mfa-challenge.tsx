import { useState } from "react";
import { Box, Button, Container, PasswordInput, Title } from "@mantine/core";
import { useLocation, useNavigate } from "react-router-dom";
import { notifications } from "@mantine/notifications";
import { AuthLayout } from "@/features/auth/components/auth-layout.tsx";
import classes from "@/features/auth/components/auth.module.css";
import { completeMfaLogin } from "@/features/security/services/security-service.ts";
import { getPostLoginRedirect } from "@/lib/app-route.ts";

export default function MfaChallengePage() {
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { state } = useLocation();
  const challengeId =
    state?.challengeId ??
    new URLSearchParams(window.location.hash.slice(1)).get("challengeId");

  async function submit() {
    setLoading(true);
    try {
      if (!challengeId) throw new Error("MFA sign-in challenge is missing");
      await completeMfaLogin(challengeId, code);
      navigate(getPostLoginRedirect());
    } catch (error) {
      notifications.show({
        message:
          error?.["response"]?.data?.message ?? "Invalid verification code",
        color: "red",
      });
    }
    setLoading(false);
  }

  return (
    <AuthLayout>
      <Container size={420} className={classes.container}>
        <Box p="xl" className={classes.containerBox}>
          <Title order={1} size="h2" ta="center" fw={500} mb="md">
            Verify your sign-in
          </Title>
          <PasswordInput
            label="Authenticator code"
            value={code}
            onChange={(event) => setCode(event.currentTarget.value)}
          />
          <Button
            fullWidth
            mt="md"
            loading={loading}
            disabled={!code || !challengeId}
            onClick={submit}
          >
            Continue
          </Button>
        </Box>
      </Container>
    </AuthLayout>
  );
}
