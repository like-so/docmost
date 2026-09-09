import { describe, expect, it, vi } from "vitest";
import api from "@/lib/api-client";
import {
  confirmOAuthAuthorization,
  deleteOAuthClient,
  listOAuthGrants,
  revokeOAuthGrant,
} from "./oauth-service";

vi.mock("@/lib/api-client", () => ({
  default: { delete: vi.fn(), get: vi.fn(), post: vi.fn() },
}));
describe("OAuth client service", () => {
  it("revokes an authorized client", async () => {
    vi.mocked(api.delete).mockResolvedValue({} as any);
    await deleteOAuthClient("client");
    expect(api.delete).toHaveBeenCalledWith("/oauth/clients/client");
  });

  it("posts only the opaque consent transaction", async () => {
    vi.mocked(api.post).mockResolvedValue({
      data: { redirectUri: "https://app/callback" },
    } as any);
    await expect(
      confirmOAuthAuthorization("transaction", "csrf", "allow"),
    ).resolves.toEqual({ redirectUri: "https://app/callback" });
    expect(api.post).toHaveBeenCalledWith("/oauth/authorize/confirm", {
      transaction: "transaction",
      csrf: "csrf",
      decision: "allow",
    });
  });

  it("lists and revokes the current user's grants", async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [{ id: "grant" }] } as any);
    vi.mocked(api.delete).mockResolvedValue({} as any);
    await expect(listOAuthGrants()).resolves.toEqual([{ id: "grant" }]);
    await revokeOAuthGrant("grant");
    expect(api.get).toHaveBeenCalledWith("/oauth/grants");
    expect(api.delete).toHaveBeenCalledWith("/oauth/grants/grant");
  });
});
