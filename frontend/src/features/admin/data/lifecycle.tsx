/**
 * Maps the overview report + automation status onto the eight lifecycle stages (ADR-017).
 * Pure: every status, metric and label comes from API fields; nothing is simulated.
 */
import {
  ClipboardText, FileMagnifyingGlass, FlagCheckered, IdentificationCard, Sparkle, Target, UploadSimple, UserPlus,
} from "@phosphor-icons/react";

import type { Automation, Overview } from "@/api/types";
import type { PipelineStage, PipelineStatus } from "@/components/shared/Pipeline";
import { formatScore } from "@/lib/format";
import { label } from "@/lib/statusLabels";

import { formatIst, triggerLabel } from "./common";

const GRADE_ORDER = ["A1", "A", "B+", "B", "C", "D"] as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const sum = (r: Record<string, number> | undefined, keys: string[]) => keys.reduce((n, k) => n + (r?.[k] ?? 0), 0);
const ratio = (n: number, d: number) => (d > 0 ? n / d : 0);

export function buildLifecycle(o: Overview, automation: Automation | undefined, opts: { archived?: boolean } = {}): PipelineStage[] {
  const t = o.trainees;
  const p = o.projects;
  const al = o.allocation;
  const s = o.submissions;
  const auto = automation ?? o.automation;

  const trainees = t?.total ?? 0;
  const assessed = t?.assessment_complete ?? 0;
  const profileOnly = t?.profile_only ?? 0;

  const projects = p?.total ?? 0;
  const ready = p?.ready ?? 0;
  const bp = p?.by_processing ?? {};
  const projFailed = sum(bp, ["failed"]);
  const projRunning = sum(bp, ["queued", "processing"]);
  const projAttention = sum(bp, ["needs_attention", "awaiting_supervisor", "awaiting_document"]);

  const assigned = al?.assigned ?? 0;
  const unassigned = al?.unassigned ?? 0;
  const pool = assigned + unassigned;

  const notSubmitted = s?.not_submitted ?? 0;
  const awaitingEval = s?.submitted ?? 0;
  const rework = s?.rework_requested ?? 0;
  const evaluated = s?.evaluated ?? 0;
  const submittedAny = awaitingEval + rework + evaluated;
  const ba = s?.by_analysis ?? {};
  const anaError = sum(ba, ["failed", "not_analyzable"]);
  const anaRunning = sum(ba, ["queued", "extracting", "analysing", "retrying"]);
  const anaReview = sum(ba, ["review_required", "insufficient_evidence"]);

  const nonZero = (r: Record<string, number>, kind: "processing" | "analysis") =>
    Object.entries(r).filter(([, n]) => n > 0).map(([k, n]) => ({ label: label(kind, k)[0], value: n }));

  // 1. Onboarding
  const onboarding: PipelineStage = {
    key: "onboarding",
    title: "Trainee Onboarding",
    icon: <UserPlus />,
    status: trainees ? "done" : "idle",
    statusLabel: trainees ? `${trainees} enrolled` : "No trainees yet",
    metric: trainees,
    metricLabel: "trainees",
    summary: "Open Trainees to download the CSV template and bulk upload trainees with their phone login accounts. Trainees can also register themselves or link an existing record through an invitation.",
    details: t ? [
      { label: "Imported", value: Math.max(0, trainees - t.self_registered) },
      { label: "Self-registered", value: t.self_registered },
      { label: "Linked accounts", value: t.linked_accounts },
      { label: "Pending invitations", value: o.users.pending_invitations },
    ] : [],
    link: { to: "/admin/trainees", label: "Upload or manage trainees" },
  };

  // 2. Profile verification
  const verifyStatus: PipelineStatus = !trainees ? "idle" : profileOnly ? "waiting" : "done";
  const verification: PipelineStage = {
    key: "verification",
    title: "Profile Verification",
    icon: <IdentificationCard />,
    status: verifyStatus,
    statusLabel: !trainees ? "Not started" : profileOnly ? `${profileOnly} unverified` : "All verified",
    metric: trainees ? `${assessed}/${trainees}` : undefined,
    metricLabel: "verified",
    progress: trainees ? ratio(assessed, trainees) : undefined,
    summary: profileOnly
      ? "Trainees without verified practical marks are matched in profile mode (skills 60, interest 40) so allocation is never blocked. Once the programme team records their scores, they move to full mode."
      : "Trainees with verified practical marks are matched in full mode (35/30/20/15). Trainees without them use profile mode (60/40).",
    details: t ? [
      { label: "Verified (full mode)", value: assessed },
      { label: "Profile-based", value: profileOnly },
      ...t.by_trade.slice(0, 6).map((x) => ({ label: x.name, value: x.count })),
    ] : [],
    link: { to: "/admin/tracking", label: "Open trainees" },
  };

  // 3. Project analysis
  const projStatus: PipelineStatus = !projects ? "idle" : projFailed ? "error" : projRunning ? "active" : projAttention ? "attention" : "done";
  const analysis: PipelineStage = {
    key: "projects",
    title: "Project Analysis",
    icon: <FileMagnifyingGlass />,
    status: projStatus,
    statusLabel: {
      idle: "No projects yet",
      error: `${projFailed} failed`,
      active: `${projRunning} processing`,
      attention: `${projAttention} need input`,
      done: "All ready",
      waiting: undefined,
    }[projStatus],
    metric: projects ? `${ready}/${projects}` : undefined,
    metricLabel: "ready",
    progress: projects ? ratio(ready, projects) : undefined,
    summary: "The background worker reads each uploaded project document, extracts trades and required skills, and marks the project ready. Projects without a document or a supervisor wait for input.",
    details: nonZero(bp, "processing"),
    link: { to: "/admin/projects", label: "Open projects" },
  };

  // 4. AI-assisted matching
  const ranOnce = !!auto.last_allocation_at;
  const matchStatus: PipelineStatus = !trainees ? "idle" : !ready ? "waiting" : ranOnce ? "done" : "waiting";
  const matching: PipelineStage = {
    key: "matching",
    title: "AI-Assisted Matching",
    icon: <Sparkle />,
    status: matchStatus,
    statusLabel: !trainees ? "Not started" : !ready ? "Waiting for ready projects" : ranOnce ? `Last run ${shortTime(auto.last_allocation_at)}` : "First run pending",
    metric: al?.average_match_score != null ? formatScore(al.average_match_score) : undefined,
    metricLabel: "average match / 100",
    summary: "Each trainee is scored against every ready project in their trades with deterministic rules. Every score is itemised into factors that add up to it, and gender is never an input. AI only writes the plain-language explanation of the factors.",
    details: [
      { label: "Full mode", value: al?.by_mode.full ?? 0 },
      { label: "Profile mode", value: al?.by_mode.profile ?? 0 },
      { label: "Explanations", value: auto.ai_configured ? "AI-assisted (redacted)" : "Rule-based fallback" },
      { label: "Ready projects", value: ready },
    ],
  };

  // 5. Automated allocation
  const pending = al?.pending_replacements ?? 0;
  const allocStatus: PipelineStatus = !pool ? "idle" : pending ? "active" : unassigned ? "waiting" : "done";
  const allocation: PipelineStage = {
    key: "allocation",
    title: "Automated Allocation",
    icon: <Target />,
    status: allocStatus,
    statusLabel: { idle: "Not started", active: `${plural(pending, "replacement")} queued`, waiting: `${unassigned} waiting`, done: "All assigned", attention: undefined, error: undefined }[allocStatus],
    metric: pool ? `${assigned}/${pool}` : undefined,
    metricLabel: "assigned",
    progress: pool ? ratio(assigned, pool) : undefined,
    summary: opts.archived
      ? "This cycle is archived; allocation no longer runs in it."
      : `The worker allocates every ${auto.interval_minutes} minutes and on events (a project becomes ready, a trainee onboards or is imported, a rejection). Each trainee holds at most one active project; a rejected project is excluded for that trainee and replaced by the next-ranked one.`,
    details: [
      { label: "Unassigned", value: unassigned },
      { label: "Rejections", value: al?.rejections_total ?? 0 },
      { label: "Replacements pending", value: pending },
      { label: "Replacements done", value: al?.completed_replacements ?? 0 },
      ...Object.entries(al?.by_trigger ?? {}).filter(([, n]) => n > 0).map(([k, n]) => ({ label: `Via ${triggerLabel(k).toLowerCase()}`, value: n })),
      ...(opts.archived ? [] : [
        { label: "Last run", value: auto.last_allocation_at ? formatIst(auto.last_allocation_at) : "Not run yet" },
        { label: "Next run (estimate)", value: auto.next_allocation_estimate ? formatIst(auto.next_allocation_estimate) : "—" },
      ]),
    ],
    link: { to: "/admin/tracking", label: "Open allocation" },
  };

  // 6. Student submission
  const subStatus: PipelineStatus = !assigned ? "idle" : notSubmitted ? "waiting" : rework ? "attention" : "done";
  const submission: PipelineStage = {
    key: "submission",
    title: "Student Submission",
    icon: <UploadSimple />,
    status: subStatus,
    statusLabel: { idle: "Not started", waiting: `${notSubmitted} not submitted`, attention: `${rework} in rework`, done: "All submitted", active: undefined, error: undefined }[subStatus],
    metric: assigned ? `${submittedAny}/${submittedAny + notSubmitted}` : undefined,
    metricLabel: "submitted",
    progress: assigned ? ratio(submittedAny, submittedAny + notSubmitted) : undefined,
    summary: "A written report is required (a video alone is not enough). Trainees can reject their project only before their first submission; later versions follow the rework loop.",
    details: [
      { label: "Not submitted", value: notSubmitted },
      { label: "Awaiting evaluation", value: awaitingEval },
      { label: "Rework requested", value: rework },
      { label: "Late", value: s?.late ?? 0 },
    ],
    link: { to: "/admin/tracking", label: "Open progress" },
  };

  // 7. Evaluation
  const evalStatus: PipelineStatus = !submittedAny ? "idle" : anaError ? "error" : anaRunning ? "active" : anaReview ? "attention" : awaitingEval ? "waiting" : "done";
  const evaluation: PipelineStage = {
    key: "evaluation",
    title: "Evaluation",
    icon: <ClipboardText />,
    status: evalStatus,
    statusLabel: {
      idle: "Not started",
      error: `${anaError} analysis failed`,
      active: `${anaRunning} analysing`,
      attention: `${anaReview} need review`,
      waiting: `${awaitingEval} awaiting supervisor`,
      done: "Up to date",
    }[evalStatus],
    metric: submittedAny ? evaluated : undefined,
    metricLabel: "evaluated",
    progress: submittedAny ? ratio(evaluated, submittedAny) : undefined,
    summary: "Every report gets an automated rubric evaluation and a Plagiarism & Originality Analysis (deterministic text overlap; semantic similarity and AI-writing are reported as not assessed). Supervisors review the result, then finalise or request rework.",
    details: [...nonZero(ba, "analysis"), { label: "Awaiting supervisor", value: awaitingEval }],
    link: { to: "/admin/tracking", label: "Open progress" },
  };

  // 8. Completion
  const open = Math.max(0, assigned - evaluated);
  const doneStatus: PipelineStatus = !assigned || !evaluated ? "idle" : open ? "waiting" : "done";
  const completion: PipelineStage = {
    key: "completion",
    title: "Completion",
    icon: <FlagCheckered />,
    status: doneStatus,
    statusLabel: { idle: assigned ? "No results yet" : "Not started", waiting: `${open} still open`, done: "All evaluated", active: undefined, attention: undefined, error: undefined }[doneStatus],
    metric: assigned ? `${Math.round(ratio(evaluated, assigned) * 100)}%` : undefined,
    metricLabel: "complete",
    progress: assigned ? ratio(evaluated, assigned) : undefined,
    summary: "A trainee is complete once their latest version is evaluated. Archiving the cycle freezes outcomes and keeps every record.",
    details: [
      { label: "Evaluated", value: evaluated },
      { label: "Still open", value: open },
      ...GRADE_ORDER.filter((g) => (o.grades?.[g] ?? 0) > 0).map((g) => ({ label: `Grade ${g}`, value: o.grades?.[g] ?? 0 })),
    ],
  };

  return [onboarding, verification, analysis, matching, allocation, submission, evaluation, completion];
}

function shortTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

/** Worker health from the automation status. */
export function workerHealth(a: Automation): { status: PipelineStatus; label: string } {
  if (a.failed_jobs_24h) return { status: "error", label: `${plural(a.failed_jobs_24h, "failed job")} in 24 h` };
  if (a.queued_jobs) return { status: "active", label: `${plural(a.queued_jobs, "job")} queued` };
  return { status: "done", label: "Worker idle, no failures" };
}
