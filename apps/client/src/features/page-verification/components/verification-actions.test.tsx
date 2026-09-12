import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { VerificationActions } from "./verification-actions";

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

describe("VerificationActions", () => {
  it("renders status and invokes every verification action", () => {
    const acknowledge = vi.fn();
    const verify = vi.fn();
    const reject = vi.fn();
    render(
      <MantineProvider>
        <VerificationActions
          status="requested"
          onAcknowledge={acknowledge}
          onVerify={verify}
          onReject={reject}
        />
        ,
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    expect(screen.getByText("requested")).toBeTruthy();
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(verify).toHaveBeenCalledOnce();
    expect(reject).toHaveBeenCalledOnce();
  });
});
