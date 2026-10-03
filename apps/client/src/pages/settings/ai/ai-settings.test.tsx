import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AiSettings from "./ai-settings";

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      matches: false,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}
if (!window.ResizeObserver) {
  Object.defineProperty(window, "ResizeObserver", {
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
}

const api = vi.hoisted(() => ({
  getAiProvider: vi.fn(),
  getRagRetrievalSettings: vi.fn(),
  getRagSettings: vi.fn(),
  updateAiControls: vi.fn(),
  updateAiProvider: vi.fn(),
  updateRagRetrievalSettings: vi.fn(),
  updateRagSettings: vi.fn(),
}));

vi.mock("@/features/ai/services/ai-service", () => ({
  getAiProvider: api.getAiProvider,
  getRagRetrievalSettings: api.getRagRetrievalSettings,
  getRagSettings: api.getRagSettings,
  updateAiControls: api.updateAiControls,
  updateAiProvider: api.updateAiProvider,
  updateRagRetrievalSettings: api.updateRagRetrievalSettings,
  updateRagSettings: api.updateRagSettings,
  // Types only below this line; the component imports them for typing.
}));

vi.mock("@/components/settings/settings-title", () => ({
  default: ({ title }: { title: string }) => <h1>{title}</h1>,
}));
vi.mock("jotai", () => ({
  useAtomValue: () => ({
    settings: { ai: { search: true, chat: true, generative: true } },
  }),
}));
vi.mock("@/features/user/atoms/current-user-atom", () => ({
  workspaceAtom: {},
}));

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  api.getAiProvider.mockResolvedValue({
    configured: true,
    driver: "openai-compatible",
    baseUrl: "https://api.example.com",
    chatModel: "gpt-4o-mini",
    embeddingModel: "text-embedding-3-small",
  });
  api.getRagRetrievalSettings.mockResolvedValue({
    search: {
      recallCount: 50,
      vectorThreshold: 0.15,
      keywordThreshold: 0.3,
      rerankModel: null,
      rerankTopK: 10,
      rerankThreshold: 0.2,
    },
    chat: {
      recallCount: 20,
      vectorThreshold: 0.1,
      keywordThreshold: 0.2,
      rerankModel: null,
      rerankTopK: 5,
      rerankThreshold: 0.2,
      rewriteEnabled: true,
      expansionEnabled: false,
      queryUnderstandingModel: null,
      rewriteSystemPrompt: "",
      rewriteUserPrompt: "",
    },
  });
  api.getRagSettings.mockResolvedValue({ enabled: false, indexProfile: null });
  api.updateRagSettings.mockImplementation(async (input) => ({
    enabled: input.enabled,
    indexProfile: {
      ...input.indexProfileConfig,
      profileId: "profile-1",
      profileHash: "hash-1",
    },
  }));
  api.updateRagRetrievalSettings.mockImplementation(async (input) => ({
    search: {
      recallCount: 50,
      vectorThreshold: 0.15,
      keywordThreshold: 0.3,
      rerankModel: null,
      rerankTopK: 10,
      rerankThreshold: 0.2,
      ...input.search,
    },
    chat: {
      recallCount: 20,
      vectorThreshold: 0.1,
      keywordThreshold: 0.2,
      rerankModel: null,
      rerankTopK: 5,
      rerankThreshold: 0.2,
      rewriteEnabled: true,
      expansionEnabled: false,
      queryUnderstandingModel: null,
      rewriteSystemPrompt: "",
      rewriteUserPrompt: "",
      ...input.chat,
    },
  }));
});

const show = () =>
  render(
    <MantineProvider>
      <AiSettings />
    </MantineProvider>,
  );

describe("index profile setup", () => {
  it("lets a new workspace create its index profile from the UI", async () => {
    show();
    const createButton = await screen.findByRole("button", {
      name: "Create index profile",
    });
    expect(createButton).toHaveProperty("disabled", true);
    fireEvent.change(await screen.findByLabelText("Index embedding model"), {
      target: { value: "text-embedding-3-small" },
    });
    fireEvent.change(screen.getByLabelText("Embedding dimensions"), {
      target: { value: "1536" },
    });
    fireEvent.change(screen.getByLabelText("Embedding max input tokens"), {
      target: { value: "8191" },
    });
    expect(createButton).toHaveProperty("disabled", false);
    fireEvent.click(createButton);
    await waitFor(() =>
      expect(api.updateRagSettings).toHaveBeenCalledWith({
        enabled: false,
        indexProfileConfig: {
          parserVersion: "v1",
          chunkerVersion: "v1",
          maxChunkTokens: 512,
          overlapTokens: 64,
          sourcePolicy: {
            requiredMimeTypes: [],
            imageInterpretation: "disabled",
          },
          embedding: {
            driver: "openai-compatible",
            endpointIdentity: null,
            model: "text-embedding-3-small",
            dimensions: 1536,
            tokenizerId: null,
            maxInputTokens: 8191,
          },
          indexingStrategy: { vectorEnabled: true, keywordEnabled: true },
        },
      }),
    );
  });

  it("reports a denied settings load differently from a load failure", async () => {
    api.getRagRetrievalSettings.mockRejectedValue({
      response: { status: 403 },
    });
    show();
    expect(
      await screen.findByText(
        "Owner access is required to view these settings.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Search retrieval")).toBeNull();
  });

  it("shows a settings load error outside the settings cards", async () => {
    api.getRagRetrievalSettings.mockRejectedValue(new Error("network down"));
    show();
    expect(
      await screen.findByText(
        "These settings are unavailable. Check your connection and reload.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText("Search retrieval")).toBeNull();
  });
});

describe("retrieval settings save and readback", () => {
  it("saves independent search and chat defaults and applies the readback", async () => {
    show();
    fireEvent.click(
      await screen.findByRole("button", { name: "Save retrieval settings" }),
    );
    await waitFor(() =>
      expect(api.updateRagRetrievalSettings).toHaveBeenCalledWith({
        search: {
          recallCount: 50,
          vectorThreshold: 0.15,
          keywordThreshold: 0.3,
          rerankModel: null,
          rerankTopK: 10,
          rerankThreshold: 0.2,
        },
        chat: {
          recallCount: 20,
          vectorThreshold: 0.1,
          keywordThreshold: 0.2,
          rerankModel: null,
          rerankTopK: 5,
          rerankThreshold: 0.2,
          rewriteEnabled: true,
          expansionEnabled: false,
          queryUnderstandingModel: null,
          rewriteSystemPrompt: "",
          rewriteUserPrompt: "",
        },
      }),
    );
    fireEvent.change(await screen.findByLabelText("Chat recall count"), {
      target: { value: "25" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Save retrieval settings" }),
    );
    await waitFor(() =>
      expect(api.updateRagRetrievalSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          chat: expect.objectContaining({ recallCount: 25 }),
        }),
      ),
    );
    expect(api.updateRagRetrievalSettings.mock.calls[0]?.[0]).not.toEqual(
      api.updateRagRetrievalSettings.mock.calls[1]?.[0],
    );
  });

  it("lands successive settings inputs in the saved payloads", async () => {
    show();
    const searchModel = await screen.findByLabelText("Rerank model");
    fireEvent.change(searchModel, { target: { value: "model-a" } });
    fireEvent.change(searchModel, { target: { value: "model-b" } });
    const chatModel = screen.getByLabelText("Chat rerank model");
    fireEvent.change(chatModel, { target: { value: "rerank-x" } });
    fireEvent.change(chatModel, { target: { value: "rerank-y" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Save retrieval settings" }),
    );
    await waitFor(() =>
      expect(api.updateRagRetrievalSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          search: expect.objectContaining({ rerankModel: "model-b" }),
          chat: expect.objectContaining({ rerankModel: "rerank-y" }),
        }),
      ),
    );
    const embeddingModel = await screen.findByLabelText(
      "Index embedding model",
    );
    fireEvent.change(embeddingModel, {
      target: { value: "text-embedding-3-large" },
    });
    fireEvent.change(embeddingModel, {
      target: { value: "text-embedding-ada-002" },
    });
    fireEvent.change(screen.getByLabelText("Embedding dimensions"), {
      target: { value: "1536" },
    });
    fireEvent.change(screen.getByLabelText("Embedding max input tokens"), {
      target: { value: "8191" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create index profile" }),
    );
    await waitFor(() =>
      expect(api.updateRagSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          indexProfileConfig: expect.objectContaining({
            embedding: expect.objectContaining({
              model: "text-embedding-ada-002",
            }),
          }),
        }),
      ),
    );
  });

  it("applies repeated toggle changes from the last toggle state", async () => {
    show();
    const rewrite = await screen.findByRole("switch", {
      name: "Rewrite follow-up questions with conversation history",
    });
    fireEvent.click(rewrite);
    fireEvent.click(rewrite);
    fireEvent.click(rewrite);
    fireEvent.click(
      screen.getByRole("button", { name: "Save retrieval settings" }),
    );
    await waitFor(() =>
      expect(api.updateRagRetrievalSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          chat: expect.objectContaining({ rewriteEnabled: false }),
        }),
      ),
    );
    const vectorChannel = await screen.findByRole("switch", {
      name: "Vector channel (semantic recall)",
    });
    fireEvent.click(vectorChannel);
    fireEvent.click(vectorChannel);
    fireEvent.click(vectorChannel);
    fireEvent.change(screen.getByLabelText("Index embedding model"), {
      target: { value: "text-embedding-3-small" },
    });
    fireEvent.change(screen.getByLabelText("Embedding dimensions"), {
      target: { value: "1536" },
    });
    fireEvent.change(screen.getByLabelText("Embedding max input tokens"), {
      target: { value: "8191" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Create index profile" }),
    );
    await waitFor(() =>
      expect(api.updateRagSettings).toHaveBeenLastCalledWith(
        expect.objectContaining({
          indexProfileConfig: expect.objectContaining({
            indexingStrategy: { vectorEnabled: false, keywordEnabled: true },
          }),
        }),
      ),
    );
  });
});
