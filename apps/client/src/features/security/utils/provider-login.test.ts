import { describe, expect, it } from "vitest";
import {
  getLoginError,
  getProviderUrl,
  getRedirectUrl,
  getVisibleProviders,
  requiresPassword,
} from "./provider-login.ts";

const providers = [
  {
    id: "oidc one",
    name: "OIDC",
    type: "oidc" as const,
    isEnabled: true,
    allowSignup: false,
  },
  {
    id: "saml",
    name: "SAML",
    type: "saml" as const,
    isEnabled: false,
    allowSignup: false,
  },
];

describe("provider login", () => {
  it("only exposes enabled providers", () => {
    expect(getVisibleProviders(providers)).toEqual([providers[0]]);
  });

  it("encodes provider identifiers in initiation paths", () => {
    expect(getProviderUrl(providers[0])).toBe("/sso/oidc%20one");
  });

  it("does not expose callback error details", () => {
    expect(getLoginError(new URLSearchParams("error=upstream-secret"))).toBe(
      "Your organization sign-in could not be completed. Try again or contact an administrator.",
    );
  });

  it("requires credentials only for LDAP providers", () => {
    expect(requiresPassword({ type: "ldap" })).toBe(true);
    expect(requiresPassword({ type: "oidc" })).toBe(false);
  });

  it("only accepts HTTPS authorization redirects", () => {
    expect(getRedirectUrl("https://idp.example/authorize")).toBe(
      "https://idp.example/authorize",
    );
    expect(getRedirectUrl("http://idp.example/authorize")).toBeUndefined();
    expect(getRedirectUrl("javascript:alert(1)")).toBeUndefined();
  });
});
