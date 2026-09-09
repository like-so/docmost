import api from "@/lib/api-client.ts";
import {
  AuthProvider,
  MfaSetup,
  NewScimToken,
  ProviderInput,
  ScimToken,
} from "@/features/security/types/security.types.ts";

export async function getProviders(): Promise<AuthProvider[]> {
  const response = await api.post<AuthProvider[]>("/security/providers/list");
  return response.data;
}

export async function getEnabledProviders(): Promise<AuthProvider[]> {
  const response = await api.post<Pick<AuthProvider, "id" | "name" | "type">[]>(
    "/security/providers/enabled",
  );
  return response.data.map((provider) => ({
    ...provider,
    isEnabled: true,
    allowSignup: false,
  }));
}

export async function createProvider(
  data: ProviderInput,
): Promise<AuthProvider> {
  const response = await api.post<AuthProvider>(
    "/security/providers/create",
    data,
  );
  return response.data;
}

export async function updateProvider(
  providerId: string,
  data: Partial<ProviderInput>,
): Promise<AuthProvider> {
  const response = await api.post<AuthProvider>("/security/providers/update", {
    id: providerId,
    ...data,
  });
  return response.data;
}

export async function deleteProvider(providerId: string): Promise<void> {
  await api.post("/security/providers/delete", { id: providerId });
}

export async function getScimTokens(): Promise<ScimToken[]> {
  const response = await api.get<ScimToken[]>("/security/scim-tokens");
  return response.data;
}

export async function createScimToken(name: string): Promise<NewScimToken> {
  const response = await api.post<NewScimToken>("/security/scim-tokens", {
    name,
  });
  return response.data;
}

export async function revokeScimToken(tokenId: string): Promise<void> {
  await api.delete(`/security/scim-tokens/${encodeURIComponent(tokenId)}`);
}

export async function updateSecurity(data: {
  enforceSso?: boolean;
  enforceMfa?: boolean;
  isScimEnabled?: boolean;
  enforceMcpOauth?: boolean;
}): Promise<void> {
  await api.post("/workspace/update", data);
}

export async function beginMfa(
  code?: string,
  password?: string,
): Promise<MfaSetup> {
  const response = await api.post<MfaSetup>("/auth/mfa/setup", {
    code,
    password,
  });
  return response.data;
}

export async function verifyMfa(code: string): Promise<void> {
  await api.post("/auth/mfa/verify", { code });
}

export async function completeMfaLogin(
  challengeId: string,
  code: string,
): Promise<void> {
  await api.post("/auth/mfa/challenge", { challengeId, code });
}

export async function beginMfaLoginSetup(setupId: string): Promise<MfaSetup> {
  const response = await api.post<MfaSetup>("/auth/mfa/setup/challenge", {
    setupId,
  });
  return response.data;
}

export async function completeMfaLoginSetup(
  setupId: string,
  code: string,
): Promise<void> {
  await api.post("/auth/mfa/setup/challenge/verify", { setupId, code });
}

export async function disableMfa(code: string): Promise<void> {
  await api.post("/auth/mfa/disable", { code });
}

export async function startProvider(providerId: string): Promise<string> {
  const response = await api.post<{ url: string }>(
    `/sso/${encodeURIComponent(providerId)}`,
  );
  return response.data.url;
}

export async function loginWithLdap(
  providerId: string,
  username: string,
  password: string,
): Promise<{
  mfaRequired?: true;
  challengeId?: string;
  mfaSetupRequired?: true;
  setupId?: string;
}> {
  const response = await api.post<{
    mfaRequired?: true;
    challengeId?: string;
    mfaSetupRequired?: true;
    setupId?: string;
  }>(`/sso/${encodeURIComponent(providerId)}/ldap`, {
    username,
    password,
  });
  return response.data;
}
