/** The single label map for every status badge (frontend.md §3). Badges always show text. */
export type Variant = "info" | "success" | "warning" | "danger" | "neutral";

export const LABELS = {
  cycle: {
    draft: ["Planning", "info"],
    published: ["Active", "success"],
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
    verified_assessment_required: ["Verified practical score needed", "warning"],
    below_min_match: ["Below minimum match", "warning"],
  },
  processing: {
    awaiting_document: ["Awaiting document", "warning"],
    queued: ["Queued", "neutral"],
    processing: ["Processing…", "info"],
    awaiting_supervisor: ["Awaiting supervisor", "warning"],
    needs_attention: ["Needs attention", "warning"],
    ready: ["Ready", "success"],
    failed: ["Failed", "danger"],
  },
  analysis: {
    queued: ["Analysis queued", "neutral"],
    extracting: ["Reading report…", "info"],
    analysing: ["Analysing…", "info"],
    completed: ["Analysed", "success"],
    retrying: ["Retrying", "warning"],
    failed: ["Analysis failed", "danger"],
    insufficient_evidence: ["Insufficient evidence", "warning"],
    review_required: ["Review required", "warning"],
    not_analyzable: ["Not analysable", "danger"],
  },
  allocationStatus: { active: ["Active", "success"], rejected: ["Rejected", "neutral"] },
  matchMode: { full: ["Full assessment mode", "info"], profile: ["Profile-based mode", "neutral"] },
  replacement: {
    queued: ["Replacement queued", "info"],
    completed: ["Replaced", "success"],
    waiting_for_eligible_trainee: ["Waiting for an eligible trainee", "warning"],
    cancelled: ["Cancelled", "neutral"],
  },
  waiting: {
    no_ready_projects: ["No ready projects yet", "neutral"],
    all_ready_projects_rejected: ["All matching projects rejected", "warning"],
    no_project_for_trades: ["No project for their trades", "warning"],
    verified_assessment_required: ["Needs verified practical score", "warning"],
    below_min_practical: ["Below minimum practical", "warning"],
    below_min_match: ["Below minimum match", "warning"],
    no_eligible_project: ["No eligible project", "warning"],
    cycle_archived: ["Cycle archived", "neutral"],
  },
  scoreType: { automated_report: ["Automated report", "info"], verified_practical: ["Verified practical", "success"] },
  allocationSource: {
    auto: ["Automatic", "neutral"],
    manual: ["Manual", "info"],
    override: ["Override", "warning"],
    replacement: ["Replacement", "info"],
  },
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
