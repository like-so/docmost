import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createProvider,
  createScimToken,
  deleteProvider,
  getEnabledProviders,
  getProviders,
  getScimTokens,
  revokeScimToken,
  updateProvider,
  updateSecurity,
} from "@/features/security/services/security-service.ts";
import { ProviderInput } from "@/features/security/types/security.types.ts";

const providerKey = ["security-providers"];
const scimKey = ["security-scim-tokens"];

export function useEnabledProviders() {
  return useQuery({
    queryKey: ["security-enabled-providers"],
    queryFn: getEnabledProviders,
  });
}

export function useProviders(enabled = true) {
  return useQuery({ queryKey: providerKey, queryFn: getProviders, enabled });
}

export function useScimTokens(enabled = true) {
  return useQuery({ queryKey: scimKey, queryFn: getScimTokens, enabled });
}

export function useCreateProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createProvider,
    onSuccess: () => client.invalidateQueries({ queryKey: providerKey }),
  });
}

export function useUpdateProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<ProviderInput> }) =>
      updateProvider(id, data),
    onSuccess: () => client.invalidateQueries({ queryKey: providerKey }),
  });
}

export function useDeleteProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: deleteProvider,
    onSuccess: () => client.invalidateQueries({ queryKey: providerKey }),
  });
}

export function useCreateScimToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: createScimToken,
    onSuccess: () => client.invalidateQueries({ queryKey: scimKey }),
  });
}

export function useRevokeScimToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: revokeScimToken,
    onSuccess: () => client.invalidateQueries({ queryKey: scimKey }),
  });
}

export function useUpdateSecurity() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: updateSecurity,
    onSuccess: () => client.invalidateQueries({ queryKey: ["workspace"] }),
  });
}
