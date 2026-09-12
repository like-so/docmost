import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import MfaChallengePage from "./mfa-challenge";

const completeMfaLogin = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());

vi.mock("@/features/security/services/security-service.ts", () => ({ completeMfaLogin }));
vi.mock("@/lib/app-route.ts", () => ({ getPostLoginRedirect: () => "/after-login" }));
vi.mock("@mantine/notifications", () => ({ notifications: { show: vi.fn() } }));
vi.mock("react-router-dom", async () => ({ ...(await vi.importActual<typeof import("react-router-dom")>("react-router-dom")), useNavigate: () => navigate, useLocation: () => ({ state: { challengeId: "challenge" } }) }));

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({ addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
}

function renderPage() {
  render(<MantineProvider><MemoryRouter><MfaChallengePage /></MemoryRouter></MantineProvider>);
}

describe("MfaChallengePage", () => {
  beforeEach(() => vi.clearAllMocks());
  it("submits TOTP by default and redirects after success", async () => {
    completeMfaLogin.mockResolvedValueOnce(undefined);
    renderPage();
    fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(completeMfaLogin).toHaveBeenCalledWith("challenge", "totp", "123456"));
    expect(navigate).toHaveBeenCalledWith("/after-login");
  });

  it("submits backup recovery when selected", async () => {
    completeMfaLogin.mockResolvedValueOnce(undefined);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Backup code" }));
    fireEvent.change(screen.getByLabelText("Backup code"), { target: { value: "backup" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(completeMfaLogin).toHaveBeenCalledWith("challenge", "backup", "backup"));
  });

  it("keeps the challenge input available after failed verification", async () => {
    completeMfaLogin.mockRejectedValueOnce(new Error("invalid"));
    renderPage();
    fireEvent.change(screen.getByLabelText("Authenticator code"), { target: { value: "bad" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(completeMfaLogin).toHaveBeenCalled());
    expect((screen.getByLabelText("Authenticator code") as HTMLInputElement).value).toBe("bad");
    expect(navigate).not.toHaveBeenCalled();
  });
});
