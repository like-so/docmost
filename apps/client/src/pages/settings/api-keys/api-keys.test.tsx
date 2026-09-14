import { MantineProvider } from "@mantine/core";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ApiKeys from "./api-keys";
import ApiKeyManagement from "./api-key-management";

const service = vi.hoisted(() => ({
  listApiKeys: vi.fn(), listWorkspaceApiKeys: vi.fn(),
  createApiKey: vi.fn(), renameApiKey: vi.fn(), revokeApiKey: vi.fn(),
  renameWorkspaceApiKey: vi.fn(), revokeWorkspaceApiKey: vi.fn(),
}));
const role = vi.hoisted(() => ({ isAdmin: true }));
vi.mock("@/features/api-key/services/api-key-service", () => service);
vi.mock("@/hooks/use-user-role", () => ({ default: () => role }));
vi.mock("@/components/settings/settings-title", () => ({ default: ({ title }: { title: string }) => <h1>{title}</h1> }));
Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
const show = (ui: React.ReactNode) => render(<MantineProvider>{ui}</MantineProvider>);
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks(); role.isAdmin = true;
  service.listApiKeys.mockResolvedValue([{ id: "personal", name: "My key" }]);
  service.listWorkspaceApiKeys.mockResolvedValue([{ id: "workspace", name: "Team key", creatorId: "owner" }]);
  service.createApiKey.mockResolvedValue({ token: "new-token" });
});
describe("API key initial loading and mutations", () => {
  it("loads personal keys and refreshes after rename, create and revoke", async () => {
    const expectedExpiration = new Date();
    expectedExpiration.setDate(expectedExpiration.getDate() + 90);
    const expectedLocalExpiration = new Date(
      expectedExpiration.getTime() -
        expectedExpiration.getTimezoneOffset() * 60_000,
    )
      .toISOString()
      .slice(0, 16);

    show(<ApiKeys />);
    expect((screen.getByLabelText("Expires at") as HTMLInputElement).value).toBe(
      expectedLocalExpiration,
    );
    const input = await screen.findByLabelText("Name for My key");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(service.renameApiKey).toHaveBeenCalledWith("personal", "Renamed"));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New key" } });
    fireEvent.click(screen.getByRole("button", { name: "Create key" }));
    expect(await screen.findByText("Copy this key now: new-token")).toBeTruthy();
    expect(service.createApiKey).toHaveBeenCalledWith(
      "New key",
      ["read"],
      expectedLocalExpiration,
    );
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(service.revokeApiKey).toHaveBeenCalledWith("personal"));
    await waitFor(() => expect(service.listApiKeys).toHaveBeenCalledTimes(4));
  });
  it("does not request workspace keys for non-administrators", () => {
    role.isAdmin = false;
    show(<ApiKeyManagement />);
    expect(screen.getByText("Only workspace administrators can manage API keys.")).toBeTruthy();
    expect(service.listWorkspaceApiKeys).not.toHaveBeenCalled();
  });
  it("loads and refreshes workspace keys for an administrator", async () => {
    show(<ApiKeyManagement />);
    fireEvent.change(await screen.findByLabelText("Name for Team key"), { target: { value: "Team renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(service.renameWorkspaceApiKey).toHaveBeenCalledWith("workspace", "Team renamed"));
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(service.revokeWorkspaceApiKey).toHaveBeenCalledWith("workspace"));
    await waitFor(() => expect(service.listWorkspaceApiKeys).toHaveBeenCalledTimes(3));
  });
});
