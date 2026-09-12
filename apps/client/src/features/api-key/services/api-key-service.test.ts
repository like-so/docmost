import { describe, expect, it, vi } from "vitest";
import api from "@/lib/api-client";
import {
  createApiKey,
  listWorkspaceApiKeys,
  renameApiKey,
  revokeApiKey,
  revokeWorkspaceApiKey,
} from "./api-key-service";

vi.mock("@/lib/api-client", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));

describe("api key service", () => {
  it("returns the one-time bearer from personal creation", async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { token: "once" } } as any);
    await expect(
      createApiKey("automation", ["read", "write"], "2027-01-01T00:00"),
    ).resolves.toEqual({ token: "once" });
    expect(api.post).toHaveBeenCalledWith("/api-keys", {
      name: "automation",
      scopes: ["read", "write"],
      expiresAt: "2027-01-01T00:00",
    });
  });

  it("renames and revokes a personal key", async () => {
    vi.mocked(api.patch).mockResolvedValue({} as any);
    vi.mocked(api.delete).mockResolvedValue({} as any);
    await renameApiKey("key", "renamed");
    await revokeApiKey("key");
    expect(api.patch).toHaveBeenCalledWith("/api-keys/key", {
      name: "renamed",
    });
    expect(api.delete).toHaveBeenCalledWith("/api-keys/key");
  });

  it("uses the separate workspace management endpoints", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [] } as any);
    vi.mocked(api.delete).mockResolvedValue({} as any);
    await expect(listWorkspaceApiKeys()).resolves.toEqual([]);
    await revokeWorkspaceApiKey("key");
    expect(api.get).toHaveBeenCalledWith("/api-keys/admin");
    expect(api.delete).toHaveBeenCalledWith("/api-keys/admin/key");
  });
});
