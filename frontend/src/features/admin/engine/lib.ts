/** Pure helpers for the admin engine pages (recommendations, allocations). No React, no I/O. */
import { ApiError, errorMessage } from "@/api/errors";
import type { AllocationRun, Recommendation, RecommendationRun } from "@/api/types";

// ---------------------------------------------------------------- recommendation runs

export const ACTIVE_RUN_STATUSES = ["queued", "running"] as const;

export function isActiveRun(status: string | null | undefined): boolean {
  return status === "queued" || status === "running";
}

export function isTerminalRun(status: string | null | undefined): boolean {
  return status === "completed" || status === "failed";
}

/** Progress of a run as `done / total` and a clamped 0–100 percentage. A finished run always shows 100 %. */
export function runProgress(run: Pick<RecommendationRun, "progress_done" | "trainee_count" | "status">) {
  const total = Math.max(0, run.trainee_count);
  const done = Math.max(0, Math.min(run.progress_done, total));
  if (run.status === "completed") return { done: total, total, pct: 100 };
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return { done, total, pct };
}

type RunSnap = { id?: string | null; status?: string | null };

/**
 * True when a run finished since the previous observation: it moved from active to terminal, or a different run
 * appeared already terminal (a fast run that completed between polls). `prev = null` means "first observation".
 */
export function runJustFinished(prev: RunSnap | null, next: RunSnap): boolean {
  if (!prev || !isTerminalRun(next.status)) return false;
  return isActiveRun(prev.status) || (prev.id ?? null) !== (next.id ?? null);
}

// ---------------------------------------------------------------- allocation runs

export const UNALLOCATED_REASON_LABEL: Record<AllocationRun["unallocated_trainees"][number]["reason"], string> = {
  assessment_pending: "Assessment pending",
  no_eligible_project: "No eligible project",
  no_capacity: "No capacity left",
};

// ---------------------------------------------------------------- override-reason flow (ALLOC-03/04)

export const OVERRIDE_MIN = 10;
export const OVERRIDE_MAX = 500;

export const INELIGIBLE_REASON_TEXT: Record<string, string> = {
  trade_mismatch: "The project targets a different trade",
  below_min_practical: "Practical score is below the project's minimum",
  assessment_pending: "Assessment is pending",
};

/** Validates the override reason the way the server does (trimmed, 10–500 chars). Returns an error or null. */
export function validateOverrideReason(value: string): string | null {
  const v = value.trim();
  if (v.length < OVERRIDE_MIN) return `Give a reason of at least ${OVERRIDE_MIN} characters`;
  if (v.length > OVERRIDE_MAX) return `Keep the reason to ${OVERRIDE_MAX} characters or fewer`;
  return null;
}

/** When the server asks for an override reason, returns the ineligibility messages it listed; otherwise null. */
export function overrideReasonsFrom(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.code !== "OVERRIDE_REASON_REQUIRED") return null;
  const msgs = err.details.map((d) => d.message).filter(Boolean);
  return msgs.length ? msgs : [err.message];
}

/** Local hint before submitting: the known recommendation for the chosen pair says it is ineligible. */
export function knownIneligibility(rec: Pick<Recommendation, "eligible" | "ineligible_reasons"> | undefined): string[] | null {
  if (!rec || rec.eligible) return null;
  return rec.ineligible_reasons.map((r) => INELIGIBLE_REASON_TEXT[r] ?? r);
}

/** Body for ALLOC-03/04: the reason is sent only when the field is shown (the server ignores it for eligible pairs). */
export function allocationBody<T extends { project_id: string }>(base: T, reasonShown: boolean, reason: string) {
  return reasonShown && reason.trim() ? { ...base, override_reason: reason.trim() } : base;
}

/** UI text for allocation write errors (admin.md §3.6 / §9.2). */
export function allocationErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return errorMessage(err);
  switch (err.code) {
    case "PROJECT_NOT_AVAILABLE": return "Project is not published.";
    case "TRAINEE_ALREADY_ALLOCATED": return "This trainee already has an allocation.";
    case "TRAINEE_HAS_SUBMISSIONS": return "This trainee has submissions; the allocation is locked.";
    case "PROJECT_FULL": return "This project is full. Choose another project or raise its capacity.";
    case "NO_RECOMMENDATIONS": return "Run recommendations first.";
    case "RUN_IN_PROGRESS": return "A recommendation run is in progress. Wait for it to finish.";
    case "INVALID_STATE":
      return err.details.length ? err.details.map((d) => d.message).join(" ") : err.message;
    default: return errorMessage(err);
  }
}

/** Every `details[].message` for INVALID_STATE-style alerts, falling back to the message. */
export function detailMessages(err: unknown): string[] {
  if (err instanceof ApiError && err.details.length) return err.details.map((d) => d.message);
  return [errorMessage(err)];
}
