import { useState } from "react";
import {
  Alert,
  Button,
  Group,
  PasswordInput,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import {
  beginMfa,
  beginMfaLoginSetup,
  completeMfaLoginSetup,
  disableMfa,
  verifyMfa,
} from "@/features/security/services/security-service.ts";
import { MfaSetup } from "@/features/security/types/security.types.ts";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { getPostLoginRedirect } from "@/lib/app-route.ts";

export function MfaSettings({ setupId }: { setupId?: string }) {
  const [setup, setSetup] = useState<MfaSetup>();
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (setupId) beginMfaLoginSetup(setupId).then(setSetup);
  }, [setupId]);

  async function startSetup() {
    try {
      setSetup(await beginMfa(code || undefined, password || undefined));
    } catch (error) {
      notifications.show({
        message:
          error?.["response"]?.data?.message ?? "Unable to start MFA setup",
        color: "red",
      });
    }
  }

  async function confirmSetup() {
    setLoading(true);
    try {
      if (setupId) {
        await completeMfaLoginSetup(setupId, code);
        navigate(getPostLoginRedirect());
        return;
      }
      await verifyMfa(code);
      setSetup(undefined);
      setCode("");
      notifications.show({ message: "Multi-factor authentication enabled" });
    } catch (error) {
      notifications.show({
        message:
          error?.["response"]?.data?.message ?? "Invalid verification code",
        color: "red",
      });
    }
    setLoading(false);
  }

  async function removeMfa() {
    setLoading(true);
    try {
      await disableMfa(code);
      setCode("");
      notifications.show({ message: "Multi-factor authentication disabled" });
    } catch (error) {
      notifications.show({
        message: error?.["response"]?.data?.message ?? "Unable to disable MFA",
        color: "red",
      });
    }
    setLoading(false);
  }

  if (setup) {
    return (
      <Stack gap="sm">
        <Text fw={500}>Set up an authenticator app</Text>
        <Alert color="blue">
          Add this setup URI to your authenticator app. It is shown only while
          setup is active.
        </Alert>
        <PasswordInput
          value={setup.otpauthUrl}
          readOnly
          visibilityToggleButtonProps={{
            "aria-label": "Show authenticator setup URI",
          }}
        />
        <PasswordInput
          label="Verification code"
          value={code}
          onChange={(event) => setCode(event.currentTarget.value)}
        />
        <Button disabled={!code} loading={loading} onClick={confirmSetup}>
          Verify and enable
        </Button>
      </Stack>
    );
  }

  return (
    <Stack gap="sm">
      <Text fw={500}>Multi-factor authentication</Text>
      <Text size="sm" c="dimmed">
        Use an authenticator app to add a second sign-in factor.
      </Text>
      <Text size="sm" c="dimmed">
        Enter your password, or a current authenticator code when replacing an
        active factor.
      </Text>
      <Group>
        <PasswordInput
          label="Password to set up MFA"
          value={password}
          onChange={(event) => setPassword(event.currentTarget.value)}
        />
        <Button disabled={!password && !code} onClick={startSetup}>
          Set up MFA
        </Button>
        <PasswordInput
          label="Code to disable MFA"
          value={code}
          onChange={(event) => setCode(event.currentTarget.value)}
        />
        <Button
          color="red"
          disabled={!code}
          loading={loading}
          onClick={removeMfa}
        >
          Disable MFA
        </Button>
      </Group>
    </Stack>
  );
}
