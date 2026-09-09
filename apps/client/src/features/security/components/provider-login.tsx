import { useState } from "react";
import { Alert, Button, PasswordInput, Stack, TextInput } from "@mantine/core";
import { useSearchParams } from "react-router-dom";
import APP_ROUTE, { getPostLoginRedirect } from "@/lib/app-route.ts";
import { useEnabledProviders } from "@/features/security/queries/security-query.ts";
import {
  loginWithLdap,
  startProvider,
} from "@/features/security/services/security-service.ts";
import { AuthProvider } from "@/features/security/types/security.types.ts";
import {
  getLoginError,
  getRedirectUrl,
  getVisibleProviders,
  requiresPassword,
} from "@/features/security/utils/provider-login.ts";

export function ProviderLogin() {
  const { data, isError } = useEnabledProviders();
  const [search] = useSearchParams();
  const [loadingId, setLoadingId] = useState<string>();
  const [requestError, setRequestError] = useState(false);
  const [ldap, setLdap] = useState<AuthProvider>();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const providers = getVisibleProviders(data ?? []);
  const error = getLoginError(search);

  async function signIn(provider: AuthProvider) {
    if (requiresPassword(provider)) {
      setLdap(provider);
      return;
    }
    setLoadingId(provider.id);
    setRequestError(false);
    try {
      const redirect = getRedirectUrl(await startProvider(provider.id));
      if (!redirect) throw new Error("Invalid provider authorization URL");
      window.location.assign(redirect);
    } catch {
      setRequestError(true);
      setLoadingId(undefined);
    }
  }

  async function signInLdap() {
    if (!ldap) return;
    setLoadingId(ldap.id);
    setRequestError(false);
    try {
      const result = await loginWithLdap(ldap.id, username, password);
      if (result?.mfaRequired && result.challengeId) {
        window.location.assign(
          `${APP_ROUTE.AUTH.MFA_CHALLENGE}#challengeId=${encodeURIComponent(result.challengeId)}`,
        );
        return;
      }
      if (result?.mfaSetupRequired && result.setupId) {
        window.location.assign(
          `${APP_ROUTE.AUTH.MFA_SETUP_REQUIRED}#setupId=${encodeURIComponent(result.setupId)}`,
        );
        return;
      }
      window.location.assign(getPostLoginRedirect());
    } catch {
      setRequestError(true);
      setLoadingId(undefined);
    }
  }

  if (isError || providers.length === 0) {
    return error ? <Alert color="red">{error}</Alert> : null;
  }

  return (
    <Stack gap="xs" mb="md">
      {(error || requestError) && (
        <Alert color="red">
          {error ??
            "Your organization sign-in could not be completed. Try again or contact an administrator."}
        </Alert>
      )}
      <Alert color="blue">Sign in with your organization provider.</Alert>
      {providers.map((provider) => (
        <Button
          key={provider.id}
          loading={loadingId === provider.id}
          variant="default"
          onClick={() => signIn(provider)}
        >
          Continue with {provider.name}
        </Button>
      ))}
      {ldap && (
        <Stack gap="xs">
          <TextInput
            autoComplete="username"
            label={`${ldap.name} username`}
            value={username}
            onChange={(event) => setUsername(event.currentTarget.value)}
          />
          <PasswordInput
            autoComplete="current-password"
            label="Password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
          <Button
            disabled={!username || !password}
            loading={loadingId === ldap.id}
            onClick={signInLdap}
          >
            Sign in with {ldap.name}
          </Button>
        </Stack>
      )}
    </Stack>
  );
}
