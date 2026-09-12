import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProviderForm } from "./provider-form";

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

if (!document.fonts) {
  Object.defineProperty(document, "fonts", {
    value: {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
  });
}

if (!globalThis.ResizeObserver) {
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: class {
      disconnect = () => undefined;
      observe = () => undefined;
      unobserve = () => undefined;
    },
  });
}

describe("ProviderForm", () => {
  it("shows and submits the required non-secret SAML Entity ID", () => {
    const onSave = vi.fn();

    render(
      <MantineProvider>
        <ProviderForm
          provider={{
            id: "provider-id",
            name: "SAML",
            type: "saml",
            isEnabled: true,
            allowSignup: false,
            samlUrl: "https://idp.example/metadata",
            samlEntityId: "urn:idp:original",
          }}
          onSave={onSave}
        />
      </MantineProvider>,
    );

    const entityId = screen.getByRole("textbox", {
      name: /Expected IdP Entity ID/,
    });
    expect(entityId).toBeInstanceOf(HTMLInputElement);
    expect(entityId).toHaveProperty("type", "text");
    expect(entityId).toHaveProperty("required", true);

    fireEvent.change(entityId, { target: { value: "urn:idp:expected" } });
    fireEvent.submit(entityId.closest("form")!);

    expect(onSave.mock.calls[0][0]).toMatchObject({
      samlEntityId: "urn:idp:expected",
    });
  });
});
