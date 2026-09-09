import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { PageVerificationBadge } from "./page-verification-controls";

const service = vi.hoisted(() => ({
  acknowledgePageRead: vi.fn().mockResolvedValue({}),
  listPageVerifications: vi.fn().mockResolvedValue([
    {
      id: "verification",
      pageId: "page",
      status: "requested",
      requestedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
      type: "expiring",
      canVerify: true,
    },
  ]),
  rejectPage: vi.fn().mockResolvedValue({}),
  requestVerification: vi.fn(),
  verifyPage: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/features/page-verification/services/page-verification-service.ts", () => service);

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

describe("PageVerificationBadge", () => {
  it("shows status, expiry, read confirmation, and only authorized actions", async () => {
    render(
      <MantineProvider>
        <QueryClientProvider client={new QueryClient()}>
          <PageVerificationBadge pageId="page" />
        </QueryClientProvider>
      </MantineProvider>,
    );

    expect(await screen.findByText("requested")).toBeTruthy();
    expect(screen.getByText(/Expires/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    await waitFor(() => {
      expect(service.acknowledgePageRead).toHaveBeenCalledWith("page");
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => {
      expect(service.verifyPage).toHaveBeenCalledWith("verification");
    });
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    await waitFor(() => {
      expect(service.rejectPage).toHaveBeenCalledWith("verification");
    });
  });
});
