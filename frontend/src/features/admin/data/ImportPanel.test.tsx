import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ImportResult, Overview } from "@/api/types";

import { ImportPreview, problemsFromDetails } from "./ImportPanel";
import { buildSteps } from "./OverviewPage";

const base: ImportResult = {
  applied: false, rows: 8, created: 7, updated: 0, unchanged: 0, created_trades: [], created_skills: ["Circuit Design"],
  warnings: [], errors: [],
};

describe("ImportPreview", () => {
  it("shows the error table and disables Apply while the dry run has errors", () => {
    const onApply = vi.fn();
    render(<ImportPreview noun="projects" onApply={onApply} result={{
      ...base,
      errors: [
        { row: 9, column: "Difficulty Level", message: "must be Beginner, Intermediate or Advanced" },
        { row: 7, column: "Max Trainee Capacity", message: "must be 1–100" },
        { row: null, column: null, message: "Header row not found" },
      ],
    }} />);
    expect(screen.getByText(/3 problems found/)).toBeInTheDocument();
    const table = screen.getByRole("table");
    const rows = within(table).getAllByRole("row").slice(1);
    // sorted by row: file-level first (empty Row cell, "File"), then 7, then 9
    expect(rows.map((r) => within(r).getAllByRole("cell")[0].textContent)).toEqual(["", "7", "9"]);
    expect(within(rows[0]).getByText("File")).toBeInTheDocument();
    expect(within(rows[1]).getByText("must be 1–100")).toBeInTheDocument();
    const apply = screen.getByRole("button", { name: "Apply import" });
    expect(apply).toBeDisabled();
    fireEvent.click(apply);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("enables Apply and shows counts when the dry run is clean", () => {
    const onApply = vi.fn();
    render(<ImportPreview noun="projects" onApply={onApply} result={{ ...base, created: 8, warnings: ["2 allocations are now ineligible"] }} />);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("2 allocations are now ineligible")).toBeInTheDocument();
    expect(screen.getByText(/Circuit Design/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Apply import" }));
    expect(onApply).toHaveBeenCalledOnce();
  });
});

describe("problemsFromDetails (422 IMPORT_INVALID)", () => {
  it("parses 'row N: Column' fields and file-level errors", () => {
    expect(problemsFromDetails([
      { field: "row 7: Max Trainee Capacity", message: "must be 1–100" },
      { field: "file", message: "Missing column Project ID" },
    ])).toEqual([
      { row: null, column: "File", message: "Missing column Project ID" },
      { row: 7, column: "Max Trainee Capacity", message: "must be 1–100" },
    ]);
  });
});

describe("buildSteps", () => {
  it("marks progress through the programme-team flow", () => {
    const o = {
      cycle: { id: "c1", name: "Oct", status: "draft" },
      users: { students: 0, supervisors: 1, admins: 1, disabled: 0, pending_invitations: 0 },
      trainees: { total: 12, assessment_complete: 12, assessment_pending: 0, linked_accounts: 0, by_trade: [] },
      recommendations: { latest_run: null, trainees_with_eligible: 0, trainees_without_eligible: 12 },
      allocation: null, demand: [], submissions: null, grades: null,
    } as unknown as Overview;
    const steps = buildSteps(o, 8);
    expect(steps.map((s) => [s.key, s.done])).toEqual([
      ["cycle", true], ["trainees", true], ["projects", true], ["publish-projects", false],
      ["recs", false], ["alloc", false], ["publish", false],
    ]);
  });
});
