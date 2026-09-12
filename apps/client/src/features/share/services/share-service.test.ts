import { describe, expect, it, vi } from "vitest";
const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api-client", () => ({ default: { post } }));
import { createShare, deleteShare, getShareForPage } from "./share-service";
describe("share service", () => { it("uses page-scoped share payloads", async () => { post.mockResolvedValue({ data: { id: "share" } }); await createShare({ pageId: "page" } as any); await getShareForPage("page"); await deleteShare("share"); expect(post.mock.calls).toEqual([["/shares/create", { pageId: "page" }],["/shares/for-page", { pageId: "page" }],["/shares/delete", { shareId: "share" }]]); }); });
