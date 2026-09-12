import { MantineProvider } from "@mantine/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ChatInput from "./chat-input";

const { searchAttachments } = vi.hoisted(() => ({
  searchAttachments: vi.fn(),
}));

vi.mock("@/features/search/services/search-service", () => ({
  searchAttachments,
}));

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

describe("ChatInput attachments", () => {
  it("selects permission-filtered attachment results and sends their IDs", async () => {
    searchAttachments.mockResolvedValue([
      { id: "attachment-1", fileName: "notes.txt" },
    ]);
    const onSend = vi.fn();
    render(
      <MantineProvider>
        <ChatInput onSend={onSend} />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Attach file" }));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Find existing attachment" }),
      { target: { value: "notes" } },
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "notes.txt", hidden: true }),
      ).toBeTruthy();
    });
    fireEvent.click(
      screen.getByRole("button", { name: "notes.txt", hidden: true }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledWith("", [], [
        { id: "attachment-1", fileName: "notes.txt" },
      ]);
    });
  });

  it("uploads one bounded chat attachment and allows it to be removed", async () => {
    const onUpload = vi.fn().mockResolvedValue({
      id: "attachment-2",
      fileName: "report.pdf",
    });
    render(
      <MantineProvider>
        <ChatInput onSend={vi.fn()} onUpload={onUpload} />
      </MantineProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Attach file" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload chat file" }),
    );
    const input = document.querySelector('input[type="file"]')!;
    fireEvent.change(input, {
      target: {
        files: [
          new File(["report"], "report.pdf", { type: "application/pdf" }),
        ],
      },
    });

    await waitFor(() => expect(onUpload).toHaveBeenCalledOnce());
    expect(screen.getByText("report.pdf")).toBeTruthy();
    const removeButton = screen
      .getByText("report.pdf")
      .parentElement?.querySelector("button");
    expect(removeButton).toBeTruthy();
    fireEvent.click(removeButton!);
    expect(screen.queryByText("report.pdf")).toBeNull();
  });
});
