import api from "@/lib/api-client";

export type OAuthClient = {
  id: string;
  name: string;
  redirectUris: string[];
  scopes: string[];
};
export type OAuthGrant = {
  id: string;
  name: string;
  scopes: string[];
  clientUri: string | null;
  logoUri: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};
export async function listOAuthClients(): Promise<OAuthClient[]> {
  return (await api.get<OAuthClient[]>("/oauth/clients")).data;
}
export async function deleteOAuthClient(id: string): Promise<void> {
  await api.delete(`/oauth/clients/${id}`);
}
export async function listOAuthGrants(): Promise<OAuthGrant[]> {
  return (await api.get<OAuthGrant[]>("/oauth/grants")).data;
}
export async function revokeOAuthGrant(id: string): Promise<void> {
  await api.delete(`/oauth/grants/${id}`);
}

export async function confirmOAuthAuthorization(
  transaction: string,
  csrf: string,
  decision: "allow" | "deny",
): Promise<{ redirectUri: string }> {
  return (
    await api.post<{ redirectUri: string }>("/oauth/authorize/confirm", {
      transaction,
      csrf,
      decision,
    })
  ).data;
}
