import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantLauncher, StudentAssistant } from "./Autopilot";

const auth = vi.hoisted(() => ({ role: "student" as string }));
vi.mock("@/auth/AuthProvider", () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

const renderWith = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );

beforeEach(() => {
  auth.role = "student";
});

describe("AssistantLauncher", () => {
  it("opens the chat panel without crashing and focuses the question box", () => {
    renderWith(<AssistantLauncher />);
    fireEvent.click(screen.getByRole("button", { name: "Ask about my project" }));
    expect(screen.getByRole("dialog", { name: "Ask about my project" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your question")).toHaveFocus();
  });

  it("closes on Escape and returns focus to the launcher", () => {
    renderWith(<AssistantLauncher />);
    fireEvent.click(screen.getByRole("button", { name: "Ask about my project" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask about my project" })).toHaveFocus();
  });

  it.each(["supervisor", "admin"])("renders nothing for a %s (ADR-030)", (role) => {
    auth.role = role;
    renderWith(<AssistantLauncher />);
    expect(screen.queryByRole("button", { name: /ask about/i })).not.toBeInTheDocument();
  });
});

describe("StudentAssistant layout", () => {
  const layout = (hasProject: boolean) =>
    renderWith(
      <Routes>
        <Route element={<StudentAssistant hasProject={hasProject} />}>
          <Route index element={<p>Page body</p>} />
        </Route>
      </Routes>,
    );

  it("shows the page and the assistant once a project is allocated", () => {
    layout(true);
    expect(screen.getByText("Page body")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask about my project" })).toBeInTheDocument();
  });

  it("shows only the page while the trainee waits for a project", () => {
    layout(false);
    expect(screen.getByText("Page body")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ask about my project" })).not.toBeInTheDocument();
  });
});
