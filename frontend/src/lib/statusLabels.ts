/** The single label map for every status badge (frontend.md §3). Badges always show text. */
export type Variant = "info" | "success" | "warning" | "danger" | "neutral";

export const LABELS = {
  cycle: {
    draft: ["Planning", "info"],
    published: ["Allocations published", "success"],
    archived: ["Archived", "neutral"],
  },
  project: { draft: ["Draft", "neutral"], published: ["Published", "success"], archived: ["Archived", "neutral"] },
  assessment: { pending: ["Assessment pending", "warning"], complete: ["Assessed", "success"] },
  run: {
    queued: ["Queued", "neutral"],
    running: ["Running…", "info"],
    completed: ["Completed", "success"],
    failed: ["Failed", "danger"],
  },
  source: { rule: ["Rule-based", "neutral"], rule_ai: ["AI-assisted", "info"] },
  eligibility: {
    eligible: ["Eligible", "success"],
    trade_mismatch: ["Different trade", "danger"],
    below_min_practical: ["Below minimum practical", "warning"],
    assessment_pending: ["Assessment pending", "warning"],
  },
  allocationSource: { auto: ["Auto", "neutral"], manual: ["Manual", "info"], override: ["Override", "warning"] },
  submission: {
    submitted: ["Awaiting evaluation", "info"],
    evaluated: ["Evaluated", "success"],
    rework_requested: ["Rework requested", "warning"],
  },
  progress: {
    unallocated: ["Not allocated", "neutral"],
    allocated: ["Allocated", "info"],
    submitted: ["Submitted", "info"],
    rework_requested: ["Rework requested", "warning"],
    evaluated: ["Evaluated", "success"],
  },
  late: { late: ["Late", "warning"] },
  grade: {
    A1: ["A1 (Exemplary)", "success"],
    A: ["A (Excellent)", "success"],
    "B+": ["B+ (Very Good)", "info"],
    B: ["B (Good)", "info"],
    C: ["C (Satisfactory)", "warning"],
    D: ["D (Needs Improvement)", "danger"],
  },
  user: { active: ["Active", "success"], disabled: ["Disabled", "danger"] },
  invitation: {
    pending: ["Pending", "info"],
    accepted: ["Accepted", "success"],
    revoked: ["Revoked", "neutral"],
    expired: ["Expired", "warning"],
  },
  role: { student: ["Student", "neutral"], supervisor: ["Supervisor", "info"], admin: ["Admin", "success"] },
  difficulty: {
    beginner: ["Beginner", "neutral"],
    intermediate: ["Intermediate", "info"],
    advanced: ["Advanced", "warning"],
  },
} as const satisfies Record<string, Record<string, readonly [string, Variant]>>;

export type BadgeKind = keyof typeof LABELS;

export function label(kind: BadgeKind, value: string): [string, Variant] {
  const entry = (LABELS[kind] as Record<string, readonly [string, Variant]>)[value];
  return entry ? [entry[0], entry[1]] : [value, "neutral"];
}
