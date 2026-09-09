import { ProviderInput } from "@/features/security/types/security.types.ts";

const secretFields = [
  "oidcClientSecret",
  "samlCertificate",
  "ldapBindPassword",
  "ldapTlsCaCert",
] as const;

export function prepareProviderInput(data: ProviderInput): ProviderInput {
  const input = { ...data };
  for (const field of secretFields) {
    if (!input[field]?.trim()) delete input[field];
  }
  return input;
}
