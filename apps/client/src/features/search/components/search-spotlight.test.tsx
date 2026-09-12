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
  SearchSpotlightFilters: ({ onAskClick }: { onAskClick: () => void }) => (
    <button onClick={onAskClick}>Toggle AI</button>
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
    expect(api.semanticSearch).toHaveBeenCalledWith("first", undefined);
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
    expect(api.semanticSearch).toHaveBeenLastCalledWith("good", undefined);
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
