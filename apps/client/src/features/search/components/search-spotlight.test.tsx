import { MantineProvider } from "@mantine/core";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchSpotlight } from "./search-spotlight";

if (!globalThis.ResizeObserver) {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.defineProperty(globalThis, "ResizeObserver", {
    value: ResizeObserverStub,
  });
}
const api = vi.hoisted(() => ({ semanticSearch: vi.fn(), show: vi.fn() }));
vi.mock("@/features/ai/services/ai-service", () => ({
  semanticSearch: api.semanticSearch,
}));
vi.mock("@mantine/notifications", () => ({
  notifications: { show: api.show },
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (s: string) => s }),
}));
vi.mock("jotai", () => ({
  useAtomValue: () => ({ settings: { ai: { search: true } } }),
}));
vi.mock("@/features/user/atoms/current-user-atom.ts", () => ({
  workspaceAtom: {},
}));
vi.mock("../constants.ts", () => ({ searchSpotlightStore: {} }));
vi.mock("../hooks/use-unified-search.ts", () => ({
  useUnifiedSearch: () => ({ data: [], isFetching: false }),
}));
vi.mock("./search-result-item.tsx", () => ({
  SearchResultItem: ({ result }: { result: { id: string } }) => (
    <div>{result.id}</div>
  ),
}));
vi.mock("./search-spotlight-filters.tsx", () => ({
  SearchSpotlightFilters: ({
    onAskClick,
    onFiltersChange,
  }: {
    onAskClick: () => void;
    onFiltersChange: (filters: Record<string, unknown>) => void;
  }) => (
    <>
      <button onClick={onAskClick}>Toggle AI</button>
      <button
        onClick={() =>
          onFiltersChange({ contentType: "page", spaceId: "space-2" })
        }
      >
        Change filters
      </button>
    </>
  ),
}));
vi.mock("@mantine/spotlight", () => ({
  Spotlight: {
    Root: ({
      query,
      onQueryChange,
      children,
    }: {
      query: string;
      onQueryChange: (s: string) => void;
      children: React.ReactNode;
    }) => (
      <div>
        <input
          aria-label="Query"
          value={query}
          onChange={(e) => onQueryChange(e.currentTarget.value)}
        />
        <button onClick={() => onQueryChange(query)}>Keep query</button>
        {children}
      </div>
    ),
    Search: () => null,
    ActionsList: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    Empty: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
  },
}));
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }),
});
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  api.semanticSearch.mockResolvedValue({ items: [{ id: "First answer" }] });
});
const show = () =>
  render(
    <MantineProvider>
      <SearchSpotlight />
    </MantineProvider>,
  );
describe("AI search query changes", () => {
  it("clears the previous answer immediately when a new query is entered", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI" }));
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("First answer")).toBeTruthy();
    expect(api.semanticSearch).toHaveBeenCalledWith("first", undefined, {
      mode: "hybrid",
      retrieval: undefined,
    });
    fireEvent.click(screen.getByRole("button", { name: "Keep query" }));
    expect(screen.getByText("First answer")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "second" },
    });
    expect(screen.queryByText("First answer")).toBeNull();
    expect(api.semanticSearch).toHaveBeenCalledTimes(1);
  });
  it("can search again after an error and query change", async () => {
    api.semanticSearch.mockRejectedValueOnce(new Error("failure"));
    show();
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI" }));
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "bad" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(api.show).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "good" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("First answer")).toBeTruthy();
    expect(api.semanticSearch).toHaveBeenLastCalledWith("good", undefined, {
      mode: "hybrid",
      retrieval: undefined,
    });
  });
  it("ignores a stale answer after a newer query completes", async () => {
    let resolveFirst: (value: { items: { id: string }[] }) => void;
    let resolveSecond: (value: { items: { id: string }[] }) => void;
    api.semanticSearch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    show();
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI" }));
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "second" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await act(async () => resolveSecond!({ items: [{ id: "Second answer" }] }));
    expect(await screen.findByText("Second answer")).toBeTruthy();
    await act(async () => resolveFirst!({ items: [{ id: "First answer" }] }));
    expect(screen.queryByText("First answer")).toBeNull();
    expect(screen.getByText("Second answer")).toBeTruthy();
  });
});

describe("AI search control changes", () => {
  it("discards a deferred answer when the retrieval mode changes", async () => {
    let resolveFirst: (value: { items: { id: string }[] }) => void;
    api.semanticSearch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ items: [{ id: "Semantic answer" }] });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI" }));
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.click(screen.getByText("Semantic"));
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(api.semanticSearch).toHaveBeenLastCalledWith("first", undefined, {
      mode: "semantic",
      retrieval: undefined,
    });
    await act(async () => resolveFirst!({ items: [{ id: "Stale answer" }] }));
    expect(screen.queryByText("Stale answer")).toBeNull();
    expect(await screen.findByText("Semantic answer")).toBeTruthy();
  });

  it("discards the previous answer when filters change the effective scope", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI" }));
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "scoped" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("First answer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change filters" }));
    expect(screen.queryByText("First answer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(api.semanticSearch).toHaveBeenLastCalledWith("scoped", "space-2", {
      mode: "hybrid",
      retrieval: undefined,
    });
  });

  it("sends per-search retrieval overrides with the request", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Retrieval overrides" }),
    );
    fireEvent.change(await screen.findByLabelText("Recall count"), {
      target: { value: "7" },
    });
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() =>
      expect(api.semanticSearch).toHaveBeenCalledWith("first", undefined, {
        mode: "hybrid",
        retrieval: { recallCount: 7 },
      }),
    );
  });

  it("renders the runtime rerank fallback status instead of claiming reranking ran", async () => {
    api.semanticSearch.mockResolvedValue({
      items: [{ id: "Fallback answer" }],
      retrieval: { mode: "hybrid", rerankStatus: "failed" },
    });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI" }));
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "fallback" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Fallback answer")).toBeTruthy();
    expect(
      screen.getByText("Reranking failed; results keep the retrieval order."),
    ).toBeTruthy();
  });

  it("discards a deferred answer when the AI mode toggles off", async () => {
    let resolveFirst: (value: { items: { id: string }[] }) => void;
    api.semanticSearch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ items: [{ id: "Fresh answer" }] });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI" }));
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI" }));
    await act(async () => resolveFirst!({ items: [{ id: "Stale answer" }] }));
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI" }));
    expect(screen.queryByText("Stale answer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Fresh answer")).toBeTruthy();
  });

  it("discards a deferred answer when an override is edited", async () => {
    let resolveFirst: (value: { items: { id: string }[] }) => void;
    api.semanticSearch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ items: [{ id: "Fresh answer" }] });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Retrieval overrides" }),
    );
    fireEvent.change(await screen.findByLabelText("Recall count"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.change(screen.getByLabelText("Recall count"), {
      target: { value: "9" },
    });
    await act(async () => resolveFirst!({ items: [{ id: "Stale answer" }] }));
    expect(screen.queryByText("Stale answer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Fresh answer")).toBeTruthy();
    expect(api.semanticSearch).toHaveBeenLastCalledWith("first", undefined, {
      mode: "hybrid",
      retrieval: { recallCount: 9 },
    });
  });

  it("discards a deferred answer when the overrides are reset", async () => {
    let resolveFirst: (value: { items: { id: string }[] }) => void;
    api.semanticSearch
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValue({ items: [{ id: "Fresh answer" }] });
    show();
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Retrieval overrides" }),
    );
    fireEvent.change(await screen.findByLabelText("Recall count"), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await act(async () => resolveFirst!({ items: [{ id: "Stale answer" }] }));
    expect(screen.queryByText("Stale answer")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("Fresh answer")).toBeTruthy();
    expect(api.semanticSearch).toHaveBeenLastCalledWith("first", undefined, {
      mode: "hybrid",
      retrieval: undefined,
    });
  });

  it("sends rerank-model override inheritance, reference, and explicit clear", async () => {
    show();
    fireEvent.click(screen.getByRole("button", { name: "Toggle AI" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Retrieval overrides" }),
    );
    fireEvent.click(screen.getByText("Custom model"));
    fireEvent.change(await screen.findByLabelText("Model reference"), {
      target: { value: "rerank-model-a" },
    });
    fireEvent.change(screen.getByLabelText("Query"), {
      target: { value: "first" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() =>
      expect(api.semanticSearch).toHaveBeenLastCalledWith("first", undefined, {
        mode: "hybrid",
        retrieval: { rerankModel: "rerank-model-a" },
      }),
    );
    fireEvent.click(screen.getByText("Server-resolved"));
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() =>
      expect(api.semanticSearch).toHaveBeenLastCalledWith("first", undefined, {
        mode: "hybrid",
        retrieval: { rerankModel: null },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() =>
      expect(api.semanticSearch).toHaveBeenLastCalledWith("first", undefined, {
        mode: "hybrid",
        retrieval: undefined,
      }),
    );
  });
});
