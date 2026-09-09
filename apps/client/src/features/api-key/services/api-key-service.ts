import api from "@/lib/api-client";

export type ApiKey = {
  id: string;
  name: string;
  creatorId: string;
  scopes: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
};

export async function listApiKeys(): Promise<ApiKey[]> {
  return (await api.get<ApiKey[]>("/api-keys")).data;
}

export async function listWorkspaceApiKeys(): Promise<ApiKey[]> {
  return (await api.get<ApiKey[]>("/api-keys/admin")).data;
}

export async function createApiKey(
  name: string,
  scopes: string[] = ["read"],
  expiresAt?: string,
): Promise<{ apiKey: ApiKey; token: string }> {
  return (await api.post("/api-keys", { name, scopes, expiresAt })).data;
}

export async function renameApiKey(id: string, name: string): Promise<void> {
  await api.patch(`/api-keys/${id}`, { name });
}

export async function renameWorkspaceApiKey(
  id: string,
  name: string,
): Promise<void> {
  await api.patch(`/api-keys/admin/${id}`, { name });
}

export async function revokeApiKey(id: string): Promise<void> {
  await api.delete(`/api-keys/${id}`);
}

export async function revokeWorkspaceApiKey(id: string): Promise<void> {
  await api.delete(`/api-keys/admin/${id}`);
}
