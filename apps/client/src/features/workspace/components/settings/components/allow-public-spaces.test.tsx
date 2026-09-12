import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const modal = vi.hoisted(() => vi.fn());
const updateWorkspace = vi.hoisted(() => vi.fn().mockResolvedValue({ id: "workspace-a" }));
const setWorkspace = vi.hoisted(() => vi.fn());

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtom: () => [
    { id: "workspace-a", settings: { publicSpaces: { enabled: false } } },
    setWorkspace,
  ],
}));
vi.mock("@mantine/modals", () => ({ modals: { openConfirmModal: modal } }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/features/workspace/services/workspace-service.ts", () => ({
  updateWorkspace,
}));

import AllowPublicSpaces from "./allow-public-spaces";

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
}

describe("AllowPublicSpaces", () => {
  function renderComponent() {
    modal.mockReset();
    updateWorkspace.mockClear();
    setWorkspace.mockClear();
    render(
      <MantineProvider>
        <AllowPublicSpaces />
      </MantineProvider>,
    );
  }

  it("opens confirmation without mutating the workspace", () => {
    renderComponent();

    fireEvent.click(
      screen.getByRole("switch", { name: "Toggle allow public spaces" }),
    );

    expect(modal).toHaveBeenCalledOnce();
    expect(updateWorkspace).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("switch", {
        name: "Toggle allow public spaces",
      }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("keeps the setting unchanged when confirmation is cancelled", () => {
    renderComponent();

    fireEvent.click(
      screen.getByRole("switch", { name: "Toggle allow public spaces" }),
    );

    expect(modal.mock.calls[0][0].labels.cancel).toBe("Cancel");
    expect(updateWorkspace).not.toHaveBeenCalled();
    expect(setWorkspace).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("switch", {
        name: "Toggle allow public spaces",
      }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("updates the existing public-space setting only after confirmation", async () => {
    renderComponent();

    fireEvent.click(
      screen.getByRole("switch", { name: "Toggle allow public spaces" }),
    );
    await modal.mock.calls[0][0].onConfirm();

    expect(updateWorkspace).toHaveBeenCalledWith({ allowPublicSpaces: true });
    expect(setWorkspace).toHaveBeenCalledWith({ id: "workspace-a" });
  });
});
