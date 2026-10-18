import { describe, expect, it } from "vitest";

import type { Submission, TraineeMe } from "@/api/types";

import { buildJourney } from "./journey";

const me = {
  skills: [{ name: "Wiring" }], career_interest: "Solar", assessment_status: "pending",
  trades: [{ id: "t", name: "Electrician" }], trade: { id: "t", name: "Electrician" },
} as unknown as TraineeMe;

describe("buildJourney", () => {
  it("has six stages in order, without matching or allocation stages", () => {
    expect(buildJourney(me, null, undefined).map((s) => s.title)).toEqual([
      "Trainee Onboarding", "Profile Verification", "Project Analysis", "Student Submission", "Evaluation", "Completion",
    ]);
  });

  it("never mentions originality to the trainee", () => {
    const latest = { status: "submitted", analysis_status: "completed", version: 1 } as Submission;
    const text = buildJourney(me, null, latest).map((s) => String(s.summary)).join(" ");
    expect(text.toLowerCase()).not.toMatch(/originality|plagiarism/);
  });
});
