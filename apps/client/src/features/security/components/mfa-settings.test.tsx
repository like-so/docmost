import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { MfaSettings } from "./mfa-settings";

const service = vi.hoisted(() => ({
  beginMfa: vi.fn().mockResolvedValue({
    attemptId: "attempt-id",
    secret: "secret",
    otpauthUrl: "otpauth://totp/Docmost",
  }),
  beginMfaLoginSetup: vi.fn(),
  completeMfaLoginSetup: vi.fn(),
  disableMfa: vi.fn(),
  verifyMfa: vi.fn().mockResolvedValue({
    backupCodes: ["backup-one", "backup-two"],
  }),
}));

vi.mock("@/features/security/services/security-service.ts", () => service);

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

describe("MfaSettings", () => {
  it("displays enrollment backup codes only until the user acknowledges them", async () => {
    render(
      <MantineProvider>
        <MemoryRouter>
          <MfaSettings />
        </MemoryRouter>
      </MantineProvider>,
    );

    expect(screen.queryByText("backup-one")).toBeNull();
    fireEvent.change(screen.getByLabelText("Password to set up MFA"), {
      target: { value: "password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Set up MFA" }));
    await screen.findByText("Set up an authenticator app");
    fireEvent.change(screen.getByLabelText("Verification code"), {
      target: { value: "123456" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Verify and enable" }),
    );

    expect(await screen.findByText("backup-one")).toBeTruthy();
    expect(service.verifyMfa).toHaveBeenCalledWith("attempt-id", "123456");
    fireEvent.click(
      screen.getByRole("button", { name: "I saved these codes" }),
    );
    await waitFor(() => {
      expect(screen.queryByText("backup-one")).toBeNull();
    });
  });
});
