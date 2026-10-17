import { describe, expect, it } from "vitest";

import { ApiError } from "@/api/errors";

import {
  allocationBody, allocationErrorText, knownIneligibility, overrideReasonsFrom, runJustFinished, runProgress,
  validateOverrideReason,
} from "./lib";

describe("runProgress", () => {
  it("computes done/total and a rounded percentage", () => {
    expect(runProgress({ progress_done: 1, trainee_count: 3, status: "running" })).toEqual({ done: 1, total: 3, pct: 33 });
  });
  it("handles zero trainees and clamps overshoot", () => {
    expect(runProgress({ progress_done: 0, trainee_count: 0, status: "queued" }).pct).toBe(0);
    expect(runProgress({ progress_done: 9, trainee_count: 5, status: "running" })).toEqual({ done: 5, total: 5, pct: 100 });
  });
  it("shows a completed run as 100 %", () => {
    expect(runProgress({ progress_done: 4, trainee_count: 5, status: "completed" }).pct).toBe(100);
  });
});

describe("runJustFinished", () => {
  it("ignores the first observation", () => {
    expect(runJustFinished(null, { id: "a", status: "completed" })).toBe(false);
  });
  it("fires on active → terminal for the same run", () => {
    expect(runJustFinished({ id: "a", status: "running" }, { id: "a", status: "completed" })).toBe(true);
    expect(runJustFinished({ id: "a", status: "queued" }, { id: "a", status: "failed" })).toBe(true);
  });
  it("fires when a new run appears already finished, not when nothing changed", () => {
    expect(runJustFinished({ id: "a", status: "completed" }, { id: "b", status: "completed" })).toBe(true);
    expect(runJustFinished({ id: "a", status: "completed" }, { id: "a", status: "completed" })).toBe(false);
    expect(runJustFinished({ id: "a", status: "running" }, { id: "a", status: "running" })).toBe(false);
  });
});

describe("override-reason flow", () => {
  const overrideErr = new ApiError(422, "OVERRIDE_REASON_REQUIRED", "This pair is ineligible", [
    { field: "body.override_reason", message: "Trainee trade does not match the project" },
    { field: "body.override_reason", message: "Practical score is below the minimum" },
  ]);

  it("extracts the server's ineligibility reasons", () => {
    expect(overrideReasonsFrom(overrideErr)).toEqual([
      "Trainee trade does not match the project", "Practical score is below the minimum",
    ]);
    expect(overrideReasonsFrom(new ApiError(409, "PROJECT_FULL", "Full"))).toBeNull();
    expect(overrideReasonsFrom(new Error("x"))).toBeNull();
  });

  it("validates the reason length on trimmed text (10–500)", () => {
    expect(validateOverrideReason("   short   ")).toMatch(/at least 10/);
    expect(validateOverrideReason("Strong demo skills, mentor agreed")).toBeNull();
    expect(validateOverrideReason("x".repeat(501))).toMatch(/500/);
  });

  it("sends override_reason only when the field is shown and filled", () => {
    expect(allocationBody({ project_id: "p" }, false, "ignored reason text")).toEqual({ project_id: "p" });
    expect(allocationBody({ project_id: "p" }, true, "  ")).toEqual({ project_id: "p" });
    expect(allocationBody({ project_id: "p" }, true, "  good reason here ")).toEqual({ project_id: "p", override_reason: "good reason here" });
  });

  it("maps a known ineligible recommendation to readable reasons", () => {
    expect(knownIneligibility(undefined)).toBeNull();
    expect(knownIneligibility({ eligible: true, ineligible_reasons: [] })).toBeNull();
    expect(knownIneligibility({ eligible: false, ineligible_reasons: ["trade_mismatch"] })).toEqual(["The project targets a different trade"]);
  });

  it("maps allocation error codes to UI text", () => {
    expect(allocationErrorText(new ApiError(409, "TRAINEE_HAS_SUBMISSIONS", "x"))).toMatch(/locked/);
    expect(allocationErrorText(new ApiError(409, "INVALID_STATE", "x", [{ field: "to", message: "Cycle is archived" }]))).toBe("Cycle is archived");
  });
});
