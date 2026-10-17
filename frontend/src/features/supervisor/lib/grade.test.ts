import { describe, expect, it } from "vitest";

import { computeTotal, emptyEvaluationForm, evaluationFormSchema, gradeFor, toEvaluationBody, type EvaluationFormValues } from "./grade";

const full = (w: string, f: string, s: string, d: string, v: string): EvaluationFormValues["scores"] => ({
  workmanship: w, functional_demo: f, safety_sop: s, documentation: d, viva: v,
});

describe("gradeFor", () => {
  it.each([
    [100, "A1"], [88, "A1"], [87, "A"], [80, "A"], [79, "B+"], [75, "B+"], [74, "B"], [65, "B"],
    [64, "C"], [50, "C"], [49, "D"], [0, "D"],
  ])("total %i -> %s", (total, grade) => {
    expect(gradeFor(total)).toBe(grade);
  });
});

describe("computeTotal", () => {
  it("sums when all five are valid", () => {
    expect(computeTotal(full("24", "25", "15", "14", "18"))).toBe(96);
  });
  it("is null when any score is empty, out of range or not an integer", () => {
    expect(computeTotal(full("24", "", "15", "14", "18"))).toBeNull();
    expect(computeTotal(full("26", "25", "15", "14", "18"))).toBeNull();
    expect(computeTotal(full("2.5", "25", "15", "14", "18"))).toBeNull();
  });
});

describe("evaluationFormSchema", () => {
  it("requires all five scores for a final evaluation", () => {
    const r = evaluationFormSchema.safeParse({ ...emptyEvaluationForm(), scores: full("20", "20", "10", "10", "") });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join("."))).toEqual(["scores.viva"]);
  });
  it("rejects out-of-range scores", () => {
    const r = evaluationFormSchema.safeParse({ ...emptyEvaluationForm(), scores: full("20", "20", "16", "10", "10") });
    expect(r.error?.issues.map((i) => i.path.join("."))).toEqual(["scores.safety_sop"]);
  });
  it("requires >= 10 characters of feedback (after trim) for rework", () => {
    const base = { ...emptyEvaluationForm(), outcome: "rework_requested" as const };
    const short = evaluationFormSchema.safeParse({ ...base, feedback: "   too short   " });
    expect(short.error?.issues.map((i) => i.path.join("."))).toEqual(["feedback"]);
    expect(evaluationFormSchema.safeParse({ ...base, feedback: "Add the wiring schematic." }).success).toBe(true);
  });
  it("rejects feedback over 5000 characters", () => {
    const r = evaluationFormSchema.safeParse({ ...emptyEvaluationForm(), scores: full("1", "1", "1", "1", "1"), feedback: "x".repeat(5001) });
    expect(r.success).toBe(false);
  });
});

describe("toEvaluationBody", () => {
  it("omits empty scores and blank feedback", () => {
    expect(toEvaluationBody({ ...emptyEvaluationForm(), outcome: "rework_requested", feedback: " Redo week 2 logbook " }))
      .toEqual({ outcome: "rework_requested", feedback: "Redo week 2 logbook" });
  });
  it("sends integer scores", () => {
    expect(toEvaluationBody({ ...emptyEvaluationForm(), scores: full("24", "25", "15", "14", "18") })).toEqual({
      outcome: "evaluated",
      scores: { workmanship: 24, functional_demo: 25, safety_sop: 15, documentation: 14, viva: 18 },
    });
  });
});
