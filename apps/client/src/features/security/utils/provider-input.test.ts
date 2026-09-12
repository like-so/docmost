import { describe, expect, it } from "vitest";
import { prepareProviderInput } from "./provider-input.ts";

describe("provider input", () => {
  it("omits blank write-only secrets while retaining configured fields", () => {
    expect(
      prepareProviderInput({
        name: "Identity",
        type: "oidc",
        isEnabled: true,
        allowSignup: false,
        groupSync: false,
        oidcIssuer: "https://issuer.example",
        oidcClientId: "client",
        oidcClientSecret: "",
      }),
    ).not.toHaveProperty("oidcClientSecret");
  });

  it("retains a supplied replacement secret", () => {
    expect(
      prepareProviderInput({
        name: "Identity",
        type: "ldap",
        isEnabled: true,
        allowSignup: false,
        groupSync: false,
        ldapBindPassword: "replacement",
      }),
    ).toMatchObject({ ldapBindPassword: "replacement" });
  });

  it("retains the signup policy and allowed domains", () => {
    expect(
      prepareProviderInput({
        name: "Identity",
        type: "oidc",
        isEnabled: true,
        allowSignup: true,
        groupSync: false,
        settings: { allowedDomains: "example.com" },
      }),
    ).toMatchObject({
      allowSignup: true,
      settings: { allowedDomains: "example.com" },
    });
  });

  it("omits a blank LDAP CA certificate so it remains write-only", () => {
    expect(
      prepareProviderInput({
        name: "Directory",
        type: "ldap",
        isEnabled: true,
        allowSignup: false,
        groupSync: false,
        ldapTlsCaCert: "",
      }),
    ).not.toHaveProperty("ldapTlsCaCert");
  });

  it("retains the non-secret SAML Entity ID", () => {
    expect(
      prepareProviderInput({
        name: "SAML",
        type: "saml",
        isEnabled: true,
        allowSignup: false,
        groupSync: false,
        samlEntityId: "urn:idp",
      }),
    ).toMatchObject({ samlEntityId: "urn:idp" });
  });

});
