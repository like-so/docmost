import { describe, expect, it, vi } from "vitest";

const { useQuery, searchAttachments, searchPage } = vi.hoisted(() => ({
  useQuery: vi.fn((options) => options),
  searchAttachments: vi.fn().mockResolvedValue([]),
  searchPage: vi.fn().mockResolvedValue([]),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery }));
vi.mock("@/features/search/services/search-service", () => ({
  searchAttachments,
  searchPage,
}));

import { useUnifiedSearch } from "./use-unified-search";

describe("useUnifiedSearch attachment mode", () => {
  it("uses the permission-filtered attachment endpoint without a feature gate", async () => {
    const options = useUnifiedSearch({
      query: "report",
      contentType: "attachment",
    }) as any;

    await options.queryFn();

    expect(searchAttachments).toHaveBeenCalledWith({ query: "report" });
    expect(searchPage).not.toHaveBeenCalled();
  });
});
