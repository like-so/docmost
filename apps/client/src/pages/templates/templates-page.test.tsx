import { MantineProvider } from "@mantine/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import TemplatesPage from "./templates-page";
const service = vi.hoisted(() => ({ listTemplates: vi.fn(), createTemplate: vi.fn(), updateTemplate: vi.fn(), deleteTemplate: vi.fn(), instantiateTemplate: vi.fn() }));
vi.mock("@/features/template/services/template-service", () => service);
Object.defineProperty(window, "matchMedia", { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  service.listTemplates.mockResolvedValue([{ id: "one", title: "First", description: "First description" }, { id: "two", title: "Second", description: "Second description" }]);
  service.createTemplate.mockResolvedValue({ id: "created", title: "Canonical title", description: "Saved description" });
  service.updateTemplate.mockResolvedValue({}); service.deleteTemplate.mockResolvedValue({});
});
const show = () => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MantineProvider><TemplatesPage /></MantineProvider></QueryClientProvider>);
describe("template editing selection", () => {
  it("initializes draft fields when selecting and retains edited values for save", async () => {
    show();
    const selects = await screen.findAllByRole("button", { name: "Select" });
    fireEvent.click(selects[0]);
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("First");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(service.updateTemplate).toHaveBeenCalledWith("one", { title: "Edited", description: "First description" }));
    fireEvent.click(selects[1]);
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Second");
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Second description");
  });
  it("uses created response fields and clears the draft on deletion", async () => {
    show();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Requested title" } });
    fireEvent.click(screen.getByRole("button", { name: "Create template" }));
    await waitFor(() => expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Canonical title"));
    expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("Saved description");
    fireEvent.click(screen.getByRole("button", { name: "Delete template" }));
    await waitFor(() => expect(service.deleteTemplate).toHaveBeenCalledWith("created"));
    await waitFor(() => expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe(""));
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  });
});
