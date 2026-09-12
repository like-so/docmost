import { AuthProvider } from "@/features/security/types/security.types.ts";

export function getVisibleProviders(providers: AuthProvider[]): AuthProvider[] {
  return providers.filter((provider) => provider.isEnabled);
}

export function getProviderUrl(
  provider: Pick<AuthProvider, "id" | "type">,
): string {
  const id = encodeURIComponent(provider.id);
  return provider.type === "saml" ? `/sso/saml/${id}/login` : `/sso/${id}`;
}

export function getLoginError(search: URLSearchParams): string | undefined {
  return search.has("error") || search.has("sso_error")
    ? "Your organization sign-in could not be completed. Try again or contact an administrator."
    : undefined;
}

export function getRedirectUrl(url: string): string | undefined {
  try {
    const redirect = new URL(url);
    return redirect.protocol === "https:" ? redirect.href : undefined;
  } catch {
    return undefined;
  }
}

export function requiresPassword(
  provider: Pick<AuthProvider, "type">,
): boolean {
  return provider.type === "ldap";
}
