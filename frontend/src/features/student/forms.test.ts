import { describe, expect, it } from "vitest";

import type { Cycle, ProgressRow, Submission, TraineeMe } from "@/api/types";

import {
  ARTIFACT_REQUIRED, buildSubmissionFormData, emptySubmission, mergeSkills, nextStep, normaliseSkills, profileBody,
  resumeFileError, resumeUploadMessage, skillAddError, submissionSchema, submitBlockedReason,
} from "./forms";

const issues = (v: Partial<typeof emptySubmission>) => {
  const r = submissionSchema.safeParse({ ...emptySubmission, ...v });
  return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [i.path.join("."), i.message]));
};

describe("submission form validation", () => {
  it("requires at least one artifact", () => {
    expect(issues({ logbook_hours: "10", note: "hi" })).toEqual({ root: ARTIFACT_REQUIRED });
  });

  it("accepts any single artifact", () => {
    expect(issues({ video_url: "https://youtu.be/abc" })).toEqual({});
    expect(issues({ report_url: "https://drive.google.com/x" })).toEqual({});
    expect(issues({ file: new File(["x"], "report.PDF", { type: "application/pdf" }) })).toEqual({});
  });

  it("rejects non-https links", () => {
    expect(issues({ video_url: "http://youtu.be/abc" }).video_url).toMatch(/https/);
    expect(issues({ report_url: "javascript:alert(1)" }).report_url).toMatch(/https/);
    expect(issues({ report_url: "not a url" }).report_url).toMatch(/https/);
  });

  it("enforces numeric ranges and file type", () => {
    const r = issues({ video_url: "https://a.b", logbook_hours: "1001", bom_cost_inr: "-1" });
    expect(Object.keys(r).sort()).toEqual(["bom_cost_inr", "logbook_hours"]);
    expect(issues({ file: new File(["x"], "virus.exe") }).file).toMatch(/Allowed/);
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

  it("sends only the three self-editable keys", () => {
    const body = profileBody({ skills: ["A", "a"], career_interest: " x ", background: "" });
    expect(body).toEqual({ skills: ["A"], career_interest: "x", background: "" });
  });
});

describe("state derivation", () => {
  const cycle = { status: "published", submission_deadline: "2026-12-01T00:00:00Z" } as Cycle;
  const me = { assessment_status: "complete", allocation: { id: "a" } } as unknown as TraineeMe;
  const sub = (status: Submission["status"], version = 1) => ({ status, version }) as Submission;

  it("blocks submitting with a reason", () => {
    expect(submitBlockedReason({ ...cycle, status: "draft" }, me, undefined)).toMatch(/not published/);
    expect(submitBlockedReason(cycle, { ...me, allocation: null }, undefined)).toMatch(/no allocated/);
    expect(submitBlockedReason(cycle, me, sub("submitted", 2))).toBe("Version 2 is awaiting evaluation");
    expect(submitBlockedReason(cycle, me, sub("evaluated"))).toMatch(/evaluated/);
    expect(submitBlockedReason(cycle, me, sub("rework_requested"))).toBeNull();
    expect(submitBlockedReason(cycle, me, undefined)).toBeNull();
  });

  it("derives the dashboard next step", () => {
    expect(nextStep(null, me, undefined).text).toBe("No active cycle");
    expect(nextStep(cycle, { ...me, assessment_status: "pending" }, undefined).to).toBe("/student/profile");
    expect(nextStep({ ...cycle, status: "draft" }, me, undefined).to).toBe("/student/recommendations");
    expect(nextStep(cycle, { ...me, allocation: null }, undefined).to).toBeUndefined();
    expect(nextStep(cycle, me, { progress: "allocated" } as ProgressRow).text).toMatch(/^Submit your project work before/);
    expect(nextStep(cycle, me, { progress: "rework_requested" } as ProgressRow).to).toBe("/student/submission");
    const row = { progress: "evaluated", latest_submission: { id: "s1" }, evaluation: { grade: "A" } } as ProgressRow;
    expect(nextStep(cycle, me, row)).toMatchObject({ text: "Evaluated: grade A", to: "/student/submissions/s1" });
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
