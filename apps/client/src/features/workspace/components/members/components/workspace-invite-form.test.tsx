import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mutateAsync = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@/features/workspace/queries/workspace-query.ts", () => ({
  useCreateInvitationMutation: () => ({ isPending: false, mutateAsync }),
}));
vi.mock("@/features/group/components/multi-group-select.tsx", () => ({
  MultiGroupSelect: () => null,
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => navigate }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { WorkspaceInviteForm } from "./workspace-invite-form";

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ addEventListener: () => undefined, removeEventListener: () => undefined }),
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

describe("WorkspaceInviteForm", () => {
  function renderForm() {
    const onClose = vi.fn();
    mutateAsync.mockClear();
    navigate.mockClear();
    render(
      <MantineProvider>
        <WorkspaceInviteForm onClose={onClose} />
      </MantineProvider>,
    );
    return onClose;
  }

  function addEmail(value: string) {
    const input = screen.getByRole("combobox", {
      name: "Invite by email",
    });
    fireEvent.change(input, { target: { value } });
    fireEvent.keyDown(input, { key: "Enter" });
  }

  it("sends the existing invite payload and closes on a valid submission", async () => {
    const onClose = renderForm();
    addEmail("person@example.com");

    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await vi.waitFor(() => {
      expect(mutateAsync).toHaveBeenCalledWith({
        emails: ["person@example.com"],
        groupIds: [],
        role: "member",
      });
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith("?tab=invites");
  });

  it("does not submit an invalid email", async () => {
    renderForm();
    addEmail("not-an-email");

    fireEvent.click(screen.getByRole("button", { name: "Send invitation" }));
    await Promise.resolve();

    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
