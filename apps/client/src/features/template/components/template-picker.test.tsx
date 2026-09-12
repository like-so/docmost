import { fireEvent, render, screen } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { describe, expect, it, vi } from "vitest";
import { TemplatePicker } from "./template-picker";

if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    value: () => ({
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

const renderPicker = (ui: React.ReactNode) =>
  render(<MantineProvider>{ui}</MantineProvider>);

describe("TemplatePicker", () => {
  it("selects the requested template", () => {
    const select = vi.fn();
    renderPicker(
      <TemplatePicker
        templates={[{ id: "template-1", title: "Release notes" }]}
        onSelect={select}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Select" }));

    expect(select).toHaveBeenCalledWith("template-1");
  });

  it("shows an empty state", () => {
    renderPicker(<TemplatePicker templates={[]} onSelect={vi.fn()} />);

    expect(screen.getByText("No templates yet.")).toBeTruthy();
  });
});
