import { MantineProvider } from "@mantine/core";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CreateApiKeyModal } from "./create-api-key-modal";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: "en-US" },
  }),
}));

vi.mock("@/ee/api-key/queries/api-key-query", () => ({
  useCreateApiKeyMutation: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

if (!window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

describe("CreateApiKeyModal", () => {
  it("defaults expiration to 90 days", () => {
    render(
      <MantineProvider>
        <CreateApiKeyModal
          opened
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />
      </MantineProvider>,
    );

    expect(
      (screen.getByRole("combobox", { name: "Expiration" }) as HTMLInputElement)
        .value,
    ).toMatch(/^90 days \(/);
  });
});
