import { describe, expect, it, vi } from "vitest";

const { post } = vi.hoisted(() => ({
  post: vi.fn().mockResolvedValue({ data: { id: "attachment" } }),
}));
vi.mock("@/lib/api-client", () => ({ default: { post } }));

import { uploadChatAttachment } from "./ai-service";

describe("AI chat attachment upload", () => {
  it("uses the authenticated chat attachment endpoint", async () => {
    await uploadChatAttachment(
      "chat-id",
      new File(["note"], "note.txt", { type: "text/plain" }),
    );

    expect(post).toHaveBeenCalledWith(
      "/ai/chats/attachments/upload",
      expect.any(FormData),
      { headers: { "Content-Type": "multipart/form-data" } },
    );
  });
});
