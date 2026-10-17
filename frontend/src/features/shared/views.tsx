/** Cross-role feature views (frontend.md §4 props contracts). Read-only; actions are passed in. */
import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { errorMessage } from "@/api/errors";
import type { PageMeta, ProgressRow, Project, Recommendation, Submission, Trainee } from "@/api/types";
import {
  DataTable, DateTime, EmptyState, ErrorState, KeyValue, LoadingState, Pagination, ScoreBar, SkillChips,
  StatusBadge, useToast, type Column,
} from "@/components/shared";
import { Button, Card } from "@/components/ui";
import { formatBytes, formatInr, formatScore } from "@/lib/format";

// ---------------------------------------------------------------- projects

export function ProjectCard({ project, to, badge }: { project: Project; to: string; badge?: ReactNode }) {
  return (
    <Link to={to} className="block rounded-lg border border-border bg-surface p-4 hover:border-primary/50">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted">{project.project_code}</p>
          <h3 className="font-medium">{project.title}</h3>
        </div>
        {badge}
      </div>
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <StatusBadge kind="difficulty" value={project.difficulty} />
        <span className="rounded-full bg-neutral-bg px-2 py-0.5">{project.target_trade.name}</span>
        <span className="rounded-full bg-neutral-bg px-2 py-0.5">Min practical {formatScore(project.min_practical_score)}%</span>
        <span className="rounded-full bg-neutral-bg px-2 py-0.5">Capacity {project.max_trainees}</span>
      </div>
    </Link>
  );
}

export function ProjectDetailView({ project, actions }: { project: Project; actions?: ReactNode }) {
  return (
    <Card title={<span>{project.title} <span className="text-sm font-normal text-muted">· {project.project_code}</span></span>} actions={actions}>
      <KeyValue items={[
        ["Status", <StatusBadge key="s" kind="project" value={project.status} />],
        ["Target trade", project.target_trade.name],
        ["Difficulty", <StatusBadge key="d" kind="difficulty" value={project.difficulty} />],
        ["Minimum practical score", `${formatScore(project.min_practical_score)}%`],
        ["Capacity", `${project.max_trainees} trainees${project.stats?.allocated_count != null ? ` · ${project.stats.allocated_count} allocated` : ""}`],
        ["Category / sponsor goal", project.category ?? "—"],
        ["Supervisor", project.supervisor ? `${project.supervisor.full_name}${project.supervisor.department ? ` (${project.supervisor.department})` : ""}` : "Not assigned"],
        ["Prerequisite skills", <SkillChips key="k" skills={project.skills} />],
        ["Problem statement", project.problem_doc_url ? <a className="text-primary underline" href={project.problem_doc_url} target="_blank" rel="noreferrer noopener">Open document</a> : "—"],
        ...(project.stats?.eligible_trainee_count != null ? [["Eligible trainees (latest run)", String(project.stats.eligible_trainee_count)] as [string, string]] : []),
      ]} />
      {project.description && <p className="mt-4 whitespace-pre-wrap text-sm">{project.description}</p>}
    </Card>
  );
}

// ---------------------------------------------------------------- trainees

export function TraineeProfileView({ trainee, showSensitive }: { trainee: Trainee; showSensitive?: boolean }) {
  return (
    <Card title={<span>{trainee.full_name} <span className="text-sm font-normal text-muted">· {trainee.trainee_code}</span></span>}
      actions={<StatusBadge kind="assessment" value={trainee.assessment_status} />}>
      <KeyValue items={[
        ["Trade", trainee.trade.name],
        ["Training centre", trainee.centre_name ?? "—"],
        ["Theory score", <ScoreBar key="t" value={trainee.scores.theory} label="Theory" />],
        ["Practical score", <ScoreBar key="p" value={trainee.scores.practical} label="Practical" />],
        ["Safety compliance", <ScoreBar key="s" value={trainee.scores.safety} label="Safety" />],
        ["Skills", <SkillChips key="k" skills={trainee.skills} />],
        ["Career interest", trainee.career_interest ?? "—"],
        ["Background", trainee.background ? <span className="whitespace-pre-wrap">{trainee.background}</span> : "—"],
        ...(showSensitive ? [
          ["Gender (admin only)", trainee.gender ?? "—"] as [string, string],
          ["Account", trainee.account ? trainee.account.email : "Not linked"] as [string, string],
        ] : []),
      ]} />
    </Card>
  );
}

// ---------------------------------------------------------------- recommendations

const REASON_LABEL: Record<string, string> = {
  trade_mismatch: "trade_mismatch", below_min_practical: "below_min_practical", assessment_pending: "assessment_pending",
};

export function FactorTable({ factors }: { factors: Recommendation["factors"] }) {
  return (
    <table className="mt-2 w-full text-sm">
      <thead className="text-left text-xs text-muted">
        <tr><th scope="col" className="py-1 font-medium">Factor</th><th scope="col" className="py-1 font-medium">Points</th><th scope="col" className="py-1 font-medium">Why</th></tr>
      </thead>
      <tbody>
        {factors.map((f) => (
          <tr key={f.key} className="border-t border-border">
            <td className="py-1.5 pr-2 align-top">
              {f.label} {f.ai_refined && <span className="ml-1 rounded bg-info-bg px-1 text-[10px] font-semibold text-info" title="Refined with AI">AI</span>}
            </td>
            <td className="py-1.5 pr-2 align-top tabular-nums whitespace-nowrap">{f.max_points === 0 ? "gate" : `${formatScore(f.points, 2)} / ${f.max_points}`}</td>
            <td className="py-1.5 align-top text-muted">{f.detail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RecommendationCard({ recommendation: r, actions, compact, perspective }: {
  recommendation: Recommendation; actions?: ReactNode; compact?: boolean; perspective?: "trainee" | "project";
}) {
  const heading = perspective === "project"
    ? `${r.trainee.full_name} · ${r.trainee.trainee_code}`
    : `${r.project.title} · ${r.project.project_code}`;
  return (
    <article className="rounded-lg border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-xs text-muted">Rank {r.rank}</p>
          <h3 className="font-medium">{heading}</h3>
          {!perspective && <p className="text-xs text-muted">{r.trainee.full_name} · {r.trainee.trainee_code}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-semibold tabular-nums" aria-label={`Match score ${r.score} of 100`}>{formatScore(r.score)}</span>
          {r.eligible ? <StatusBadge kind="eligibility" value="eligible" /> : r.ineligible_reasons.map((x) => <StatusBadge key={x} kind="eligibility" value={REASON_LABEL[x] ?? x} />)}
          <StatusBadge kind="source" value={r.source} />
        </div>
      </div>
      {r.ai_explanation && <p className="mt-2 rounded-md bg-info-bg px-3 py-2 text-sm text-info">{r.ai_explanation}</p>}
      {compact ? (
        <details className="mt-2 text-sm"><summary className="cursor-pointer text-primary">Why this score?</summary><FactorTable factors={r.factors} /></details>
      ) : <FactorTable factors={r.factors} />}
      {actions && <div className="mt-3 flex flex-wrap gap-2">{actions}</div>}
    </article>
  );
}

// ---------------------------------------------------------------- submissions

function DownloadButton({ submission }: { submission: Submission }) {
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => call(api.GET("/api/v1/submissions/{submission_id}/file-url", { params: { path: { submission_id: submission.id } } })),
    onSuccess: (res) => window.open(res.data.url, "_blank", "noopener,noreferrer"),
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!submission.file) return null;
  return <Button size="sm" variant="secondary" loading={m.isPending} onClick={() => m.mutate()}>Download {submission.file.name} ({formatBytes(submission.file.size_bytes)})</Button>;
}

export const CRITERIA = [
  ["workmanship", "Workmanship & precision", 25], ["functional_demo", "Functional working demo", 25],
  ["safety_sop", "Safety & SOP adherence", 15], ["documentation", "Logbook & documentation", 15],
  ["viva", "Viva voce / oral exam", 20],
] as const;

export function EvaluationView({ evaluation }: { evaluation: NonNullable<Submission["evaluation"]> }) {
  return (
    <div className="rounded-md border border-border p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <StatusBadge kind="submission" value={evaluation.outcome} />
        {evaluation.grade && <StatusBadge kind="grade" value={evaluation.grade} />}
        {evaluation.total_score != null && <span className="text-sm font-semibold">Total {evaluation.total_score} / 100</span>}
        <span className="text-xs text-muted">by {evaluation.evaluator.full_name} · <DateTime value={evaluation.created_at} /></span>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {CRITERIA.map(([k, name, max]) => (
            <tr key={k} className="border-t border-border">
              <th scope="row" className="py-1 text-left font-normal">{name}</th>
              <td className="py-1 text-right tabular-nums">{evaluation.scores[k] ?? "—"} / {max}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {evaluation.feedback && <p className="mt-2 whitespace-pre-wrap text-sm"><span className="font-medium">Feedback: </span>{evaluation.feedback}</p>}
    </div>
  );
}

export function SubmissionDetailView({ submission: s, history, historyHref, actions }: {
  submission: Submission; history?: Submission[]; historyHref?: (s: Submission) => string; actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <Card title={`Version ${s.version} · ${s.project.title}`} actions={<div className="flex gap-2"><StatusBadge kind="submission" value={s.status} />{s.is_late && <StatusBadge kind="late" value="late" />}</div>}>
        <KeyValue items={[
          ["Trainee", `${s.trainee.full_name} · ${s.trainee.trainee_code}`],
          ["Submitted", <DateTime key="d" value={s.submitted_at} />],
          ["Video", s.video_url ? <a className="text-primary underline break-all" href={s.video_url} target="_blank" rel="noreferrer noopener">{s.video_url}</a> : "—"],
          ["Report link", s.report_url ? <a className="text-primary underline break-all" href={s.report_url} target="_blank" rel="noreferrer noopener">{s.report_url}</a> : "—"],
          ["File", s.file ? <DownloadButton key="f" submission={s} /> : "—"],
          ["Logbook hours", s.logbook_hours != null ? String(s.logbook_hours) : "—"],
          ["Bill of materials", formatInr(s.bom_cost_inr)],
          ["Note", s.note ? <span className="whitespace-pre-wrap">{s.note}</span> : "—"],
        ]} />
        {s.evaluation && <div className="mt-4"><EvaluationView evaluation={s.evaluation} /></div>}
      </Card>
      {actions}
      {history && history.length > 1 && (
        <Card title="Version history">
          <ul className="divide-y divide-border text-sm">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>Version {h.version} · <DateTime value={h.submitted_at} /></span>
                <span className="flex items-center gap-2">
                  <StatusBadge kind="submission" value={h.status} />
                  {h.evaluation?.grade && <StatusBadge kind="grade" value={h.evaluation.grade} />}
                  {historyHref && h.id !== s.id && <Link className="text-primary underline" to={historyHref(h)}>View</Link>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- progress

export function ProgressTable({ rows, meta, onPageChange, sort, onSortChange, isLoading, error, onRetry, emptyState,
  showTraineeColumn = true, showSupervisorColumn = true, getRowHref }: {
  rows: ProgressRow[]; meta?: PageMeta; onPageChange?: (p: number) => void; sort?: string; onSortChange?: (s: string) => void;
  isLoading?: boolean; error?: unknown; onRetry?: () => void; emptyState?: ReactNode; showTraineeColumn?: boolean;
  showSupervisorColumn?: boolean; getRowHref?: (r: ProgressRow) => string | null;
}) {
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!rows.length) return <>{emptyState ?? <EmptyState title="No progress rows yet" />}</>;
  const cols: Column<ProgressRow>[] = [
    ...(showTraineeColumn ? [{ key: "trainee", header: "Trainee", sort: "trainee_name", cell: (r: ProgressRow) => {
      const href = getRowHref?.(r);
      const text = <span>{r.trainee.full_name}<span className="block text-xs text-muted">{r.trainee.trainee_code} · {r.trainee.trade.name}</span></span>;
      return href ? <Link className="text-primary" to={href}>{text}</Link> : text;
    } }] : []),
    { key: "project", header: "Project", sort: "project_title", cell: (r) => r.project ? <span>{r.project.title}<span className="block text-xs text-muted">{r.project.project_code}</span></span> : <span className="text-muted">—</span> },
    ...(showSupervisorColumn ? [{ key: "sup", header: "Supervisor", cell: (r: ProgressRow) => r.supervisor?.full_name ?? "—" }] : []),
    { key: "match", header: "Match", sort: "-match_score", cell: (r) => <span className="flex flex-wrap items-center gap-1">{formatScore(r.allocation?.match_score)}{r.allocation?.is_override && <StatusBadge kind="allocationSource" value="override" />}</span> },
    { key: "progress", header: "Status", cell: (r) => <span className="flex flex-wrap gap-1"><StatusBadge kind="progress" value={r.progress} />{r.latest_submission?.is_late && <StatusBadge kind="late" value="late" />}</span> },
    { key: "version", header: "Latest version", cell: (r) => r.latest_submission ? `v${r.latest_submission.version}` : "—" },
    { key: "score", header: "Score", sort: "-total_score", cell: (r) => r.evaluation ? <span className="flex items-center gap-1">{r.evaluation.total_score}{r.evaluation.grade && <StatusBadge kind="grade" value={r.evaluation.grade} />}</span> : "—" },
  ];
  return (
    <>
      <DataTable rows={rows} columns={cols} rowKey={(r) => r.trainee.id} sort={sort} onSortChange={onSortChange} caption="Progress" />
      {onPageChange && <Pagination meta={meta} onPageChange={onPageChange} />}
    </>
  );
}
