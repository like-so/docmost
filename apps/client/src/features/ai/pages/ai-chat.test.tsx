import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AiChat from "./ai-chat";

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
  cancelChatRequest: vi.fn(),
  createChat: vi.fn(),
  getChat: vi.fn(),
  sendChatMessage: vi.fn(),
  uploadChatAttachment: vi.fn(),
}));

vi.mock("../services/ai-service", () => ({
  cancelChatRequest: api.cancelChatRequest,
  createChat: api.createChat,
  getChat: api.getChat,
  sendChatMessage: api.sendChatMessage,
  uploadChatAttachment: api.uploadChatAttachment,
}));

vi.mock("react-router-dom", () => ({
  useParams: () => ({ chatId: "chat-1" }),
  useLocation: () => ({ pathname: "/ai/chat/chat-1", state: null }),
  useNavigate: () => vi.fn(),
}));

vi.mock("@/features/space/queries/space-query", () => ({
  useGetSpacesQuery: () => ({ data: { items: [] } }),
}));

vi.mock("../components/chat-input", () => ({
  default: ({ onSend }: { onSend: (content: string) => void }) => (
    <button onClick={() => onSend("hello")}>Send test message</button>
  ),
}));

afterEach(() => {
  vi.clearAllMocks();
});

beforeEach(() => {
  api.getChat.mockResolvedValue({
    id: "chat-1",
    title: "Chat",
    createdAt: "2026-10-02T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    messages: [
      {
        id: "message-1",
        role: "user",
        content: "What is Docmost?",
        createdAt: "2026-10-02T00:00:01Z",
      },
      {
        id: "message-2",
        role: "assistant",
        content: "Docmost is a wiki.",
        createdAt: "2026-10-02T00:00:02Z",
        retrieval: { mode: "hybrid", rerankStatus: "failed" },
        sources: [
          {
            citationId: "1",
            pageId: "page-1",
            title: "Intro page",
            url: "/spaces/demo/pages/page-1",
            locator: { start: 0, end: 120 },
          },
        ],
      },
    ],
  });
  api.sendChatMessage.mockImplementation(async () => ({
    message: {
      id: "message-3",
      role: "user",
      content: "hello",
      createdAt: "2026-10-02T00:00:03Z",
    },
    assistant: {
      id: "message-4",
      role: "assistant",
      content: "Answer",
      createdAt: "2026-10-02T00:00:04Z",
      retrieval: { mode: "hybrid", rerankStatus: "applied" },
      sources: [],
    },
  }));
});

const show = () =>
  render(
    <MantineProvider>
      <AiChat />
    </MantineProvider>,
  );

describe("assistant retrieval metadata", () => {
  it("renders typed clickable sources and the runtime rerank status", async () => {
    show();
    const link = await screen.findByRole("link", {
      name: "[1] Intro page",
    });
    expect(link).toHaveProperty("href");
    expect((link as HTMLAnchorElement).getAttribute("href")).toBe(
      "/spaces/demo/pages/page-1",
    );
    expect(
      screen.getByText("Reranking failed; results keep the retrieval order."),
    ).toBeTruthy();
  });

  it("renders messages without retrieval metadata for older chats", async () => {
    api.getChat.mockResolvedValue({
      id: "chat-1",
      title: "Chat",
      createdAt: "2026-10-02T00:00:00Z",
      updatedAt: "2026-10-02T00:00:00Z",
      messages: [
        {
          id: "message-9",
          role: "assistant",
          content: "Legacy answer",
          createdAt: "2026-10-01T00:00:00Z",
        },
      ],
    });
    show();
    expect(await screen.findByText("Legacy answer")).toBeTruthy();
    expect(
      screen.queryByText("Reranking failed; results keep the retrieval order."),
    ).toBeNull();
    expect(screen.queryByText("Sources")).toBeNull();
  });

  it("sends per-message retrieval overrides with the chat request", async () => {
    show();
    await screen.findByText("Docmost is a wiki.");
    fireEvent.click(
      screen.getByRole("button", { name: "Retrieval overrides" }),
    );
    fireEvent.change(await screen.findByLabelText("Recall count"), {
      target: { value: "7" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() =>
      expect(api.sendChatMessage).toHaveBeenCalledWith(
        "chat-1",
        "hello",
        [],
        expect.any(String),
        { spaceId: undefined, retrieval: { recallCount: 7 } },
      ),
    );
  });

  it("keeps chat rerank status silent when reranking was applied", async () => {
    show();
    await screen.findByText(
      "Reranking failed; results keep the retrieval order.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send test message" }));
    await waitFor(() => expect(screen.getByText("Answer")).toBeTruthy());
    // The loaded message failed reranking; the applied-status reply must not
    // add another fallback notice.
    expect(
      screen.getAllByText(
        "Reranking failed; results keep the retrieval order.",
      ),
    ).toHaveLength(1);
  });
});
