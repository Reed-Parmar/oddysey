import { describe, expect, it } from "vitest";

import type { Automation, Overview } from "@/api/types";

import { buildLifecycle, workerHealth } from "./lifecycle";

const automation: Automation = {
  ai_configured: false,
  email_backend: "disabled",
  failed_jobs_24h: 0,
  interval_minutes: 15,
  last_allocation_at: null,
  last_allocation_result: null,
  next_allocation_estimate: null,
  queued_jobs: 0,
};

const empty: Overview = {
  allocation: null,
  automation,
  cycle: null,
  grades: null,
  projects: null,
  submissions: null,
  trainees: null,
  users: { admins: 1, disabled: 0, pending_invitations: 0, students: 0, supervisors: 0 },
};

const busy: Overview = {
  ...empty,
  trainees: { total: 10, assessment_complete: 6, profile_only: 4, self_registered: 2, linked_accounts: 8, by_trade: [] },
  projects: { total: 5, ready: 3, working_individually: 7, by_processing: { ready: 3, processing: 1, failed: 1 } },
  allocation: {
    assigned: 7, unassigned: 3, average_match_score: 72.4, by_mode: { full: 4, profile: 3 }, by_trigger: { schedule: 7 },
    completed_replacements: 1, pending_replacements: 0, rejections_total: 1,
  },
  submissions: { not_submitted: 2, submitted: 2, rework_requested: 1, evaluated: 2, late: 1, by_analysis: { analysing: 1, completed: 4 } },
  grades: { A: 1, B: 1 },
};

const byKey = (o: Overview, a?: Automation) => Object.fromEntries(buildLifecycle(o, a).map((s) => [s.key, s]));

describe("buildLifecycle", () => {
  it("returns the eight stages in order", () => {
    expect(buildLifecycle(empty, automation).map((s) => s.title)).toEqual([
      "Trainee Onboarding", "Profile Verification", "Project Analysis", "AI-Assisted Matching",
      "Automated Allocation", "Student Submission", "Evaluation", "Completion",
    ]);
  });

  it("shows an empty cycle as not started rather than done", () => {
    const stages = buildLifecycle(empty, automation);
    expect(stages.every((s) => s.status === "idle")).toBe(true);
  });

  it("derives statuses from the report counts", () => {
    const s = byKey(busy, { ...automation, last_allocation_at: "2026-10-18T06:30:00Z" });
    expect(s.onboarding.status).toBe("done");
    expect(s.verification).toMatchObject({ status: "waiting", metric: "6/10" });
    expect(s.projects).toMatchObject({ status: "error", statusLabel: "1 failed", metric: "3/5" });
    expect(s.matching.status).toBe("done");
    expect(s.allocation).toMatchObject({ status: "waiting", statusLabel: "3 waiting", metric: "7/10" });
    expect(s.submission).toMatchObject({ status: "waiting", statusLabel: "2 not submitted", metric: "5/7" });
    expect(s.evaluation).toMatchObject({ status: "active", statusLabel: "1 analysing", metric: 2 });
    expect(s.completion).toMatchObject({ status: "waiting", statusLabel: "5 still open", metric: "29%" });
  });

  it("puts processing ahead of input requests, and failures ahead of both", () => {
    const projects = (by_processing: Record<string, number>) => ({ ...busy, projects: { total: 3, ready: 1, working_individually: 0, by_processing } });
    expect(byKey(projects({ ready: 1, awaiting_document: 2 })).projects.status).toBe("attention");
    expect(byKey(projects({ ready: 1, queued: 1, awaiting_document: 1 })).projects.status).toBe("active");
    expect(byKey(projects({ ready: 3 })).projects.status).toBe("done");
  });

  it("waits for ready projects before matching", () => {
    const o = { ...busy, projects: { total: 2, ready: 0, working_individually: 0, by_processing: { queued: 2 } } };
    expect(byKey(o).matching).toMatchObject({ status: "waiting", statusLabel: "Waiting for ready projects" });
  });

  it("marks a pending replacement as running allocation", () => {
    const o = { ...busy, allocation: { ...busy.allocation!, pending_replacements: 1 } };
    expect(byKey(o).allocation).toMatchObject({ status: "active", statusLabel: "1 replacement queued" });
  });
});

describe("workerHealth", () => {
  it("reports failures first, then queued work", () => {
    expect(workerHealth({ ...automation, failed_jobs_24h: 2, queued_jobs: 3 })).toEqual({ status: "error", label: "2 failed jobs in 24 h" });
    expect(workerHealth({ ...automation, queued_jobs: 1 })).toEqual({ status: "active", label: "1 job queued" });
    expect(workerHealth(automation).status).toBe("done");
  });
});
