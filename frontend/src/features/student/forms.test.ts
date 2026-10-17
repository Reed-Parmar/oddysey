import { describe, expect, it } from "vitest";

import type { Cycle, HistoryEntry, Resume, Submission, TraineeMe } from "@/api/types";

import {
  REPORT_REQUIRED, buildSubmissionFormData, canReject, emptySubmission, initialMarks, lastRejected, markError, mergeSkills,
  nextStep, normaliseSkills, onboardingBody, onboardingMissing, onboardingSchema, onboardingValues, profileBody,
  profileSchema, rejectReasonError, reportedScoresBody, reportedValue, resumeFileError, resumeUploadMessage, skillAddError,
  submissionSchema, submitBlockedReason,
} from "./forms";

const issues = (v: Partial<typeof emptySubmission>) => {
  const r = submissionSchema.safeParse({ ...emptySubmission, ...v });
  return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join("."), i.message]));
};
const file = (name: string) => new File(["x"], name);

describe("submission form validation", () => {
  it("requires a report", () => {
    expect(issues({ logbook_hours: "10", note: "hi" })).toEqual({ root: REPORT_REQUIRED });
  });

  it("rejects a video alone", () => {
    expect(issues({ video_url: "https://youtu.be/abc" })).toEqual({ root: REPORT_REQUIRED });
  });

  it("rejects a supplement file (ZIP, PPTX, image) without a report link", () => {
    expect(issues({ file: file("work.zip") })).toEqual({ root: REPORT_REQUIRED });
    expect(issues({ file: file("slides.pptx"), video_url: "https://youtu.be/abc" })).toEqual({ root: REPORT_REQUIRED });
    expect(issues({ file: file("photo.jpg") })).toEqual({ root: REPORT_REQUIRED });
  });

  it("accepts a report link or a PDF/DOCX report file", () => {
    expect(issues({ report_url: "https://drive.google.com/x" })).toEqual({});
    expect(issues({ file: new File(["x"], "report.PDF", { type: "application/pdf" }) })).toEqual({});
    expect(issues({ file: file("report.docx"), video_url: "https://youtu.be/abc" })).toEqual({});
  });

  it("accepts a supplement file next to a report link", () => {
    expect(issues({ report_url: "https://drive.google.com/x", file: file("work.zip") })).toEqual({});
  });

  it("rejects non-https links", () => {
    expect(issues({ report_url: "https://a.b", video_url: "http://youtu.be/abc" }).video_url).toMatch(/https/);
    expect(issues({ report_url: "javascript:alert(1)" }).report_url).toMatch(/https/);
    expect(issues({ report_url: "not a url" }).report_url).toMatch(/https/);
  });

  it("enforces numeric ranges and file type", () => {
    const r = issues({ report_url: "https://a.b", logbook_hours: "1001", bom_cost_inr: "-1" });
    expect(Object.keys(r).sort()).toEqual(["bom_cost_inr", "logbook_hours"]);
    expect(issues({ report_url: "https://a.b", file: file("virus.exe") }).file).toMatch(/Allowed/);
  });

  it("builds multipart with only non-empty fields", () => {
    const fd = buildSubmissionFormData({ ...emptySubmission, report_url: " https://r.example/x ", logbook_hours: "12.5" });
    expect([...fd.keys()].sort()).toEqual(["logbook_hours", "report_url"]);
    expect(fd.get("report_url")).toBe("https://r.example/x");
  });
});

describe("profile helpers", () => {
  it("dedupes skills case-insensitively and trims", () => {
    expect(normaliseSkills([" Soldering", "soldering", "", "PLC  Wiring"])).toEqual(["Soldering", "PLC Wiring"]);
    expect(skillAddError(["Soldering"], "SOLDERING")).toMatch(/already/);
    expect(skillAddError([], "x".repeat(81))).toMatch(/80/);
    expect(skillAddError(Array.from({ length: 20 }, (_, i) => `s${i}`), "new")).toMatch(/20/);
  });

  it("sends only the four self-editable keys", () => {
    const body = profileBody({ trade_ids: ["t1", "t1", "t2"], skills: ["A", "a"], career_interest: " x ", background: "" });
    expect(body).toEqual({ trade_ids: ["t1", "t2"], skills: ["A"], career_interest: "x", background: "" });
  });

  it("requires 1 to 5 trades", () => {
    const base = { skills: [], career_interest: "", background: "" };
    expect(profileSchema.safeParse({ ...base, trade_ids: [] }).success).toBe(false);
    expect(profileSchema.safeParse({ ...base, trade_ids: ["a"] }).success).toBe(true);
    expect(profileSchema.safeParse({ ...base, trade_ids: ["a", "b", "c", "d", "e", "f"] }).success).toBe(false);
  });
});

describe("onboarding helpers", () => {
  const complete = {
    full_name: "Asha K", gender: "undisclosed", trainee_code: "ITI-2026-01", centre_name: "", trade_ids: ["t1"],
    skills: ["Wiring"], career_interest: "Electrician", background: "", cycle_id: "",
  };

  it("parses an untyped draft defensively", () => {
    expect(onboardingValues({ full_name: "A", trade_ids: ["t1", 3], skills: "x" })).toMatchObject({
      full_name: "A", gender: "", trade_ids: ["t1"], skills: [],
    });
    expect(onboardingValues(null).trainee_code).toBe("");
  });

  it("lists missing required fields like the server", () => {
    expect(onboardingMissing(complete)).toEqual([]);
    expect(onboardingMissing({ ...complete, full_name: " ", gender: "", skills: [" "], trade_ids: [] }))
      .toEqual(["full_name", "gender", "trade_ids", "skills"]);
  });

  it("validates the trainee ID format and gender values", () => {
    expect(onboardingSchema.safeParse(complete).success).toBe(true);
    expect(onboardingSchema.safeParse({ ...complete, trainee_code: "ITI 01" }).success).toBe(false);
    expect(onboardingSchema.safeParse({ ...complete, trainee_code: "x".repeat(41) }).success).toBe(false);
    expect(onboardingSchema.safeParse({ ...complete, gender: "unknown" }).success).toBe(false);
  });

  it("builds the PUT body with nulls for empty text", () => {
    expect(onboardingBody({ ...complete, skills: ["Wiring", "wiring"] })).toEqual({
      full_name: "Asha K", gender: "undisclosed", trainee_code: "ITI-2026-01", centre_name: null, trade_ids: ["t1"],
      skills: ["Wiring"], career_interest: "Electrician", background: null, cycle_id: null,
    });
    expect(onboardingBody({ ...complete, cycle_id: "c2" }).cycle_id).toBe("c2"); // explicit choice (ADR-018)
  });
});

describe("resume-reported marks", () => {
  const resume = {
    id: "r1",
    extracted: { assessment_marks: [
      { field: "theory", value: 72, excerpt: "Theory 72", status: "found", unit: "percent" },
      { field: "practical", value: null, excerpt: null, status: "not_found", unit: "percent" },
    ] },
  } as unknown as Resume;

  it("starts from the saved confirmation for the same resume, else from the resume", () => {
    expect(initialMarks(resume, null)).toEqual({ theory: "72", practical: "", safety: "" });
    const saved = { resume_id: "r1", theory: { value: 70 }, safety: { value: 88 } };
    expect(initialMarks(resume, saved)).toEqual({ theory: "70", practical: "", safety: "88" });
    expect(initialMarks(resume, { ...saved, resume_id: "old" })).toEqual({ theory: "72", practical: "", safety: "" });
    expect(reportedValue(saved, "practical")).toBeNull();
  });

  it("validates 0-100 and builds the PATCH body", () => {
    expect(markError("")).toBeNull();
    expect(markError("100")).toBeNull();
    expect(markError("101")).toMatch(/0 to 100/);
    expect(markError("abc")).toMatch(/0 to 100/);
    expect(reportedScoresBody("r1", { theory: "72.5", practical: "", safety: "0" })).toEqual({
      reported_scores: { resume_id: "r1", theory: 72.5, practical: null, safety: 0 },
    });
  });
});

describe("rejection helpers", () => {
  const cycle = { status: "published" } as Cycle;
  const me = { allocation: { id: "a", status: "active" } } as unknown as TraineeMe;

  it("needs a 10-500 character reason", () => {
    expect(rejectReasonError("too short")).toMatch(/10/);
    expect(rejectReasonError("  The project needs tools I do not have.  ")).toBeNull();
    expect(rejectReasonError("x".repeat(501))).toMatch(/500/);
  });

  it("allows rejection only before any submission while the cycle is open", () => {
    expect(canReject(cycle, me, 0)).toBe(true);
    expect(canReject(cycle, me, 1)).toBe(false);
    expect(canReject({ ...cycle, status: "archived" }, me, 0)).toBe(false);
    expect(canReject(cycle, { ...me, allocation: null }, 0)).toBe(false);
  });

  it("finds the latest rejected allocation", () => {
    const h = (id: string, status: string, rejected_at: string | null) =>
      ({ allocation: { id, status }, rejected_at }) as unknown as HistoryEntry;
    expect(lastRejected([h("a", "active", null)])).toBeUndefined();
    expect(lastRejected([h("a", "rejected", "2026-10-01T00:00:00Z"), h("b", "rejected", "2026-10-05T00:00:00Z")])?.allocation.id).toBe("b");
  });
});

describe("state derivation", () => {
  const cycle = { status: "published", submission_deadline: "2026-12-01T00:00:00Z" } as Cycle;
  const me = { allocation: { id: "a" } } as unknown as TraineeMe;
  const sub = (status: Submission["status"], version = 1, extra: object = {}) => ({ id: "s1", status, version, ...extra }) as Submission;

  it("blocks submitting with a reason", () => {
    expect(submitBlockedReason({ ...cycle, status: "archived" }, me, undefined)).toMatch(/archived/);
    expect(submitBlockedReason(cycle, { ...me, allocation: null }, undefined)).toMatch(/no allocated/);
    expect(submitBlockedReason(cycle, me, sub("submitted", 2))).toMatch(/^Version 2 is awaiting evaluation/);
    expect(submitBlockedReason(cycle, me, sub("evaluated"))).toMatch(/evaluated/);
    expect(submitBlockedReason(cycle, me, sub("rework_requested"))).toBeNull();
    expect(submitBlockedReason(cycle, me, undefined)).toBeNull();
    expect(submitBlockedReason({ ...cycle, status: "draft" }, me, undefined)).toBeNull();
  });

  it("derives the dashboard next step without suggestions or a catalogue", () => {
    expect(nextStep(null, me, undefined).text).toBe("No active programme cycle");
    const waiting = nextStep(cycle, { ...me, allocation: null }, undefined);
    expect(waiting.to).toBeUndefined();
    expect(waiting.text).toMatch(/automatically/);
    expect(nextStep(cycle, { ...me, allocation: null }, undefined, { rejectedBefore: true }).text).toMatch(/different eligible project/);
    expect(nextStep(cycle, me, undefined).text).toMatch(/^Read your project guide and submit your report before/);
    expect(nextStep(cycle, me, sub("rework_requested")).to).toBe("/student/project");
    expect(nextStep(cycle, me, sub("evaluated", 1, { evaluation: { grade: "A" } }))).toMatchObject({ text: "Evaluated: grade A", to: "/student/submissions/s1" });
    for (const s of [undefined, sub("submitted"), sub("rework_requested")]) {
      const step = nextStep(cycle, me, s);
      expect(`${step.text} ${step.to ?? ""}`).not.toMatch(/suggest|recommend|catalog|\/projects/i);
    }
  });
});

describe("resume helpers", () => {
  it("pre-checks type and size", () => {
    expect(resumeFileError({ name: "cv.pdf", size: 1000 })).toBeNull();
    expect(resumeFileError({ name: "CV.DOCX", size: 1000 })).toBeNull();
    expect(resumeFileError({ name: "cv.txt", size: 1000 })).toBe("Upload a PDF or DOCX");
    expect(resumeFileError({ name: "pdf", size: 1000 })).toBe("Upload a PDF or DOCX");
    expect(resumeFileError({ name: "cv.pdf", size: 0 })).toBe("This file is empty");
    expect(resumeFileError({ name: "cv.pdf", size: 5 * 1024 * 1024 + 1 })).toBe("Resume must be 5 MB or smaller");
  });

  it("maps upload errors to the handbook copy", () => {
    expect(resumeUploadMessage(413, "FILE_TOO_LARGE", "x")).toBe("Resume must be 5 MB or smaller");
    expect(resumeUploadMessage(415, "UNSUPPORTED_FILE_TYPE", "x")).toBe("Upload a PDF or DOCX");
    expect(resumeUploadMessage(429, "RATE_LIMITED", "x")).toBe("Too many uploads. Try again in an hour.");
    expect(resumeUploadMessage(409, "NO_TRAINEE_RECORD", "No trainee record")).toBe("No trainee record");
  });

  it("merges chosen skills without duplicates and enforces the cap", () => {
    expect(mergeSkills(["Wiring"], ["wiring", "Soldering"])).toEqual(["Wiring", "Soldering"]);
    const full = Array.from({ length: 20 }, (_, i) => `S${i}`);
    expect(mergeSkills(full, ["S1"])).toHaveLength(20);
    expect(mergeSkills(full, ["New"])).toBeNull();
  });
});
