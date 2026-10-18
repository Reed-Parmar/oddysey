import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { AssistantLauncher } from "./Autopilot";

const renderLauncher = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <AssistantLauncher />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe("AssistantLauncher", () => {
  it("opens the chat panel without crashing and focuses the question box", () => {
    renderLauncher();
    fireEvent.click(screen.getByRole("button", { name: "Ask about my project" }));
    expect(screen.getByRole("dialog", { name: "Ask about my project" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your question")).toHaveFocus();
  });

  it("closes on Escape and returns focus to the launcher", () => {
    renderLauncher();
    fireEvent.click(screen.getByRole("button", { name: "Ask about my project" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask about my project" })).toHaveFocus();
  });
});
