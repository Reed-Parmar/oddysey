import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import { Pipeline, type PipelineStage } from "./Pipeline";

const stages: PipelineStage[] = [
  { key: "a", title: "Trainee Onboarding", icon: <span />, status: "done", statusLabel: "10 enrolled", summary: "Imported." },
  { key: "b", title: "Project Analysis", icon: <span />, status: "error", statusLabel: "1 failed", summary: "A document failed.", link: { to: "/admin/projects", label: "Open projects" } },
  { key: "c", title: "Completion", icon: <span />, status: "idle", summary: "Nothing yet." },
];

const renderPipeline = () => render(<MemoryRouter><Pipeline label="Lifecycle" stages={stages} /></MemoryRouter>);

describe("Pipeline", () => {
  it("lists every stage with its status as text", () => {
    renderPipeline();
    const list = screen.getByRole("list", { name: "Lifecycle" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("10 enrolled")).toBeInTheDocument();
    expect(within(list).getByText("Not started")).toBeInTheDocument();
  });

  it("opens the stage that needs attention first", () => {
    renderPipeline();
    expect(screen.getByRole("button", { name: /^Project Analysis/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("region", { name: "Project Analysis details" })).toHaveTextContent("A document failed.");
    expect(screen.getByRole("link", { name: "Open projects" })).toHaveAttribute("href", "/admin/projects");
  });

  it("switches and closes the inspector", () => {
    renderPipeline();
    fireEvent.click(screen.getByRole("button", { name: /^Trainee Onboarding/ }));
    expect(screen.getByRole("region", { name: "Trainee Onboarding details" })).toHaveTextContent("Imported.");
    fireEvent.click(screen.getByRole("button", { name: /^Close/ }));
    expect(screen.getByText("Select a stage to see what is happening in it.")).toBeInTheDocument();
  });
});
