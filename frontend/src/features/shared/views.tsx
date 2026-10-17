/** Cross-role feature views (frontend.md §4 props contracts). Read-only; actions are passed in. */
import {
  ArrowSquareOut,
  Briefcase,
  CaretRight,
  Certificate,
  Clock,
  DownloadSimple,
  FileText,
  Link as LinkIcon,
  Note,
  Sparkle,
  UsersThree,
  VideoCamera,
  Wrench,
  CurrencyInr,
} from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { PageMeta, ProgressRow, Project, Recommendation, Resume, Submission, Trainee } from "@/api/types";
import {
  Avatar, DataTable, DateTime, EmptyState, ErrorState, KeyValue, LoadingState, Pagination, ScoreBar, SkillChips,
  StatusBadge, useToast, type Column,
} from "@/components/shared";
import { Button, Card, cx } from "@/components/ui";
import { formatBytes, formatInr, formatScore } from "@/lib/format";

const Tag = ({ children }: { children: ReactNode }) => (
  <span className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium text-neutral">{children}</span>
);

const ExternalLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="inline-flex max-w-full items-center gap-1 font-medium text-primary hover:underline [overflow-wrap:anywhere]" href={href} target="_blank" rel="noreferrer noopener">
    <span className="min-w-0">{children}</span>
    <ArrowSquareOut aria-hidden size={14} className="shrink-0" />
    <span className="sr-only">(opens in a new tab)</span>
  </a>
);

// ---------------------------------------------------------------- projects

export function ProjectCard({ project, to, badge }: { project: Project; to: string; badge?: ReactNode }) {
  return (
    <Link
      to={to}
      className="group flex h-full flex-col rounded-xl border border-border bg-surface p-5 shadow-card transition-[border-color,box-shadow] duration-150 hover:border-primary/40 hover:shadow-raised"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wide text-subtle">{project.project_code}</p>
          <h3 className="mt-1 text-base leading-snug font-semibold text-text group-hover:text-primary-ink">{project.title}</h3>
        </div>
        {badge}
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        <StatusBadge kind="difficulty" value={project.difficulty} />
        <Tag><Wrench aria-hidden size={12} />{project.target_trade.name}</Tag>
        <Tag>Min practical {formatScore(project.min_practical_score)}%</Tag>
        <Tag><UsersThree aria-hidden size={12} />Capacity {project.max_trainees}</Tag>
      </div>
      <span className="mt-auto inline-flex items-center gap-1 pt-4 text-sm font-semibold text-primary">
        View details <CaretRight aria-hidden size={14} className="transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

export function ProjectDetailView({ project, actions }: { project: Project; actions?: ReactNode }) {
  return (
    <Card
      title={<span>{project.title} <span className="text-sm font-normal text-muted">· {project.project_code}</span></span>}
      actions={actions}
    >
      <KeyValue items={[
        ["Status", <StatusBadge key="s" kind="project" value={project.status} />],
        ["Target trade", project.target_trade.name],
        ["Difficulty", <StatusBadge key="d" kind="difficulty" value={project.difficulty} />],
        ["Minimum practical score", `${formatScore(project.min_practical_score)}%`],
        ["Capacity", `${project.max_trainees} trainees${project.stats?.allocated_count != null ? ` · ${project.stats.allocated_count} allocated` : ""}`],
        ["Category / sponsor goal", project.category ?? "—"],
        ["Supervisor", project.supervisor ? `${project.supervisor.full_name}${project.supervisor.department ? ` (${project.supervisor.department})` : ""}` : "Not assigned"],
        ["Prerequisite skills", <SkillChips key="k" skills={project.skills} />],
        ["Problem statement", project.problem_doc_url ? <ExternalLink href={project.problem_doc_url}>Open document</ExternalLink> : "—"],
        ...(project.stats?.eligible_trainee_count != null ? [["Eligible trainees (latest run)", String(project.stats.eligible_trainee_count)] as [string, string]] : []),
      ]} />
      {project.description && (
        <div className="mt-5 border-t border-border pt-4">
          <h3 className="text-sm font-semibold">Description</h3>
          <p className="mt-1.5 max-w-3xl text-sm leading-relaxed whitespace-pre-wrap text-muted">{project.description}</p>
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- trainees

export function TraineeProfileView({ trainee, showSensitive }: { trainee: Trainee; showSensitive?: boolean }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-3">
          <Avatar name={trainee.full_name} />
          <span>
            {trainee.full_name}
            <span className="block text-sm font-normal text-muted">{trainee.trainee_code} · {trainee.trade.name}</span>
          </span>
        </span>
      }
      actions={<StatusBadge kind="assessment" value={trainee.assessment_status} />}
    >
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {([["Theory score", trainee.scores.theory, "Theory"], ["Practical score", trainee.scores.practical, "Practical"], ["Safety compliance", trainee.scores.safety, "Safety"]] as const).map(([k, v, l]) => (
          <div key={k} className="rounded-lg border border-border bg-surface-2 p-3">
            <p className="text-xs font-medium text-muted">{k}</p>
            <div className="mt-1.5"><ScoreBar value={v} label={l} tone="auto" /></div>
          </div>
        ))}
      </div>
      <KeyValue items={[
        ["Trade", trainee.trade.name],
        ["Training centre", trainee.centre_name ?? "—"],
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

/** Itemised factors; the points always sum to the match score. */
export function FactorTable({ factors }: { factors: Recommendation["factors"] }) {
  const total = factors.reduce((s, f) => s + (f.max_points === 0 ? 0 : f.points), 0);
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th scope="col" className="pb-2 font-semibold">Factor</th>
            <th scope="col" className="pb-2 pl-3 font-semibold">Points</th>
            <th scope="col" className="pb-2 pl-3 font-semibold">Why</th>
          </tr>
        </thead>
        <tbody>
          {factors.map((f) => {
            const pct = f.max_points > 0 ? Math.max(0, Math.min(100, (f.points / f.max_points) * 100)) : 0;
            return (
              <tr key={f.key} className="border-t border-border">
                <td className="py-2.5 pr-2 align-top font-medium">
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    {f.label}
                    {f.ai_refined && (
                      <span className="inline-flex items-center gap-0.5 rounded bg-accent-soft px-1.5 py-px text-[0.68rem] font-bold text-accent-ink" title="Refined with AI">
                        <Sparkle aria-hidden size={10} weight="fill" />AI
                      </span>
                    )}
                  </span>
                </td>
                <td className="py-2.5 pl-3 align-top whitespace-nowrap">
                  {f.max_points === 0 ? (
                    <span className="text-muted">gate</span>
                  ) : (
                    <span className="flex items-center gap-2">
                      <span aria-hidden className="hidden h-1.5 w-14 overflow-hidden rounded-full bg-neutral-bg sm:block">
                        <span className="block h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                      </span>
                      <span className="tabular-nums"><span className="font-semibold">{formatScore(f.points, 2)}</span><span className="text-muted"> / {f.max_points}</span></span>
                    </span>
                  )}
                </td>
                <td className="py-2.5 pl-3 align-top text-muted">{f.detail}</td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-border-strong">
            <th scope="row" className="pt-2.5 text-left font-semibold">Total</th>
            <td className="pt-2.5 pl-3 font-semibold tabular-nums">{formatScore(total, 2)}</td>
            <td className="pt-2.5 pl-3 text-xs text-muted">Sum of the factor points</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function ScoreDial({ score }: { score: number }) {
  const pct = Math.max(0, Math.min(100, score));
  const tone = pct >= 75 ? "var(--color-success)" : pct >= 50 ? "var(--color-primary)" : pct >= 30 ? "var(--color-warning)" : "var(--color-danger)";
  return (
    <span
      className="relative inline-flex size-14 shrink-0 items-center justify-center rounded-full"
      style={{ background: `conic-gradient(${tone} ${pct * 3.6}deg, var(--color-neutral-bg) 0deg)` }}
      aria-label={`Match score ${score} of 100`}
      role="img"
    >
      <span className="inline-flex size-11 items-center justify-center rounded-full bg-surface font-heading text-base font-semibold tabular-nums">
        {formatScore(score)}
      </span>
    </span>
  );
}

export function RecommendationCard({ recommendation: r, actions, compact, perspective }: {
  recommendation: Recommendation; actions?: ReactNode; compact?: boolean; perspective?: "trainee" | "project";
}) {
  const heading = perspective === "project"
    ? `${r.trainee.full_name} · ${r.trainee.trainee_code}`
    : `${r.project.title} · ${r.project.project_code}`;
  return (
    <article className="rounded-xl border border-border bg-surface p-5 shadow-card">
      <div className="flex items-start gap-4">
        <ScoreDial score={r.score} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <p className="text-xs font-semibold tracking-wide text-subtle uppercase">Rank {r.rank}</p>
              <h3 className="mt-0.5 text-base leading-snug font-semibold">{heading}</h3>
              {!perspective && <p className="text-xs text-muted">{r.trainee.full_name} · {r.trainee.trainee_code}</p>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {r.eligible ? <StatusBadge kind="eligibility" value="eligible" /> : r.ineligible_reasons.map((x) => <StatusBadge key={x} kind="eligibility" value={x} />)}
              <StatusBadge kind="source" value={r.source} />
            </div>
          </div>
        </div>
      </div>
      {r.ai_explanation && (
        <div className="mt-4 rounded-lg border border-accent/20 bg-accent-soft px-4 py-3 text-sm">
          <p className="flex items-center gap-1.5 text-xs font-bold tracking-wide text-accent-ink uppercase">
            <Sparkle aria-hidden size={14} weight="fill" /> AI explanation
          </p>
          <p className="mt-1 leading-relaxed text-text">{r.ai_explanation}</p>
        </div>
      )}
      {compact ? (
        <details className="group mt-3 text-sm">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded font-semibold text-primary [&::-webkit-details-marker]:hidden">
            <CaretRight aria-hidden size={14} className="transition-transform group-open:rotate-90" />
            Why this score?
          </summary>
          <FactorTable factors={r.factors} />
        </details>
      ) : <FactorTable factors={r.factors} />}
      {actions && <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">{actions}</div>}
    </article>
  );
}

// ---------------------------------------------------------------- resumes (ADR-015)

export const RESUME_SOURCE_LABEL = { ai: "AI", rule: "Keyword match" } as const;

/** Resume download via RES-04 (5-minute signed URL). Students (own) and admins only. */
export function ResumeDownloadButton({ resume }: { resume: Resume }) {
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => call(api.GET("/api/v1/resumes/{resume_id}/file-url", { params: { path: { resume_id: resume.id } } })),
    onSuccess: (res) => window.open(res.data.url, "_blank", "noopener,noreferrer"),
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!resume.file_name) return null;
  return (
    <Button size="sm" variant="secondary" icon={<DownloadSimple />} loading={m.isPending} onClick={() => m.mutate()}>
      Download {resume.file_name}{resume.file_size_bytes != null && ` (${formatBytes(resume.file_size_bytes)})`}
    </Button>
  );
}

/** Read-only view of what was found in a resume. `skills` lets the student view render selectable chips. */
export function ResumeExtractionView({ resume, skills }: { resume: Resume; skills?: ReactNode }) {
  const x = resume.extracted;
  if (resume.status === "failed" || !x) {
    return (
      <p className="text-sm text-muted">
        {resume.error_code === "no_text"
          ? "No text could be read from this file. It looks like a scanned image, which would need OCR. Upload a PDF or DOCX that contains text."
          : "This file could not be read. It may be damaged or password-protected."}
      </p>
    );
  }
  const list = (items: string[]) => (items.length ? <SkillChips skills={items.map((name) => ({ name }))} /> : <span className="text-muted">None found</span>);
  return (
    <div className="flex flex-col gap-4 text-sm">
      <div>
        <h3 className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">Skills</h3>
        {skills ?? list(x.skills)}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className="mb-2 flex items-center gap-1 text-xs font-semibold tracking-wide text-muted uppercase"><Wrench aria-hidden size={14} />Tools</h3>
          {list(x.tools)}
        </div>
        <div>
          <h3 className="mb-2 flex items-center gap-1 text-xs font-semibold tracking-wide text-muted uppercase"><Certificate aria-hidden size={14} />Certifications</h3>
          {list(x.certifications)}
        </div>
      </div>
      <div>
        <h3 className="mb-2 flex items-center gap-1 text-xs font-semibold tracking-wide text-muted uppercase"><Briefcase aria-hidden size={14} />Projects</h3>
        {x.projects.length ? (
          <ul className="flex flex-col gap-2">
            {x.projects.map((p, i) => (
              <li key={i} className="rounded-lg border border-border bg-surface-2 px-3 py-2">
                <p className="font-semibold text-text [overflow-wrap:anywhere]">{p.title}</p>
                {p.summary && <p className="mt-0.5 text-muted [overflow-wrap:anywhere]">{p.summary}</p>}
              </li>
            ))}
          </ul>
        ) : <span className="text-muted">None found</span>}
      </div>
      {x.career_interest_hint && (
        <p><span className="text-muted">Career interest: </span><span className="font-medium text-text">{x.career_interest_hint}</span></p>
      )}
    </div>
  );
}

/** RES-03 card for staff views. Supervisors get the extraction only (the API never returns the file to them). */
export function TraineeResumeCard({ traineeId, canDownload }: { traineeId: string; canDownload?: boolean }) {
  const q = useQuery({
    queryKey: qk.resumes.trainee(traineeId),
    queryFn: () => call(api.GET("/api/v1/trainees/{trainee_id}/resume", { params: { path: { trainee_id: traineeId } } })),
  });
  const r = q.data?.data;
  return (
    <Card
      title="From resume"
      icon={<FileText />}
      description={r ? <>Uploaded <DateTime value={r.created_at} />{r.source && ` � ${RESUME_SOURCE_LABEL[r.source]}`}. Suggestions only; the trainee decides which skills to add.</> : undefined}
      actions={r && canDownload ? <ResumeDownloadButton resume={r} /> : undefined}
    >
      {q.isLoading ? <LoadingState /> : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !r ? (
        <p className="text-sm text-muted">No resume uploaded.</p>
      ) : (
        <ResumeExtractionView resume={r} />
      )}
    </Card>
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
  return (
    <Button size="sm" variant="secondary" icon={<DownloadSimple />} loading={m.isPending} onClick={() => m.mutate()}>
      Download {submission.file.name} ({formatBytes(submission.file.size_bytes)})
    </Button>
  );
}

export const CRITERIA = [
  ["workmanship", "Workmanship & precision", 25], ["functional_demo", "Functional working demo", 25],
  ["safety_sop", "Safety & SOP adherence", 15], ["documentation", "Logbook & documentation", 15],
  ["viva", "Viva voce / oral exam", 20],
] as const;

export function EvaluationView({ evaluation }: { evaluation: NonNullable<Submission["evaluation"]> }) {
  return (
    <div className="rounded-xl border border-border bg-surface-2 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <StatusBadge kind="submission" value={evaluation.outcome} />
        {evaluation.grade && <StatusBadge kind="grade" value={evaluation.grade} />}
        {evaluation.total_score != null && <span className="font-heading text-sm font-semibold tabular-nums">Total {evaluation.total_score} / 100</span>}
        <span className="text-xs text-muted">by {evaluation.evaluator.full_name} · <DateTime value={evaluation.created_at} /></span>
      </div>
      <ul className="space-y-2.5">
        {CRITERIA.map(([k, name, max]) => {
          const v = evaluation.scores[k];
          const pct = v == null ? 0 : Math.max(0, Math.min(100, (v / max) * 100));
          return (
            <li key={k}>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span>{name}</span>
                <span className="tabular-nums"><span className="font-semibold">{v ?? "—"}</span><span className="text-muted"> / {max}</span></span>
              </div>
              <div aria-hidden className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-bg">
                <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      {evaluation.feedback && (
        <div className="mt-4 rounded-lg border border-border bg-surface px-4 py-3 text-sm">
          <p className="text-xs font-bold tracking-wide text-muted uppercase">Feedback</p>
          <p className="mt-1 leading-relaxed whitespace-pre-wrap">{evaluation.feedback}</p>
        </div>
      )}
    </div>
  );
}

function Evidence({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3 rounded-lg border border-border p-3">
      <span aria-hidden className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary [&>svg]:size-4">{icon}</span>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-muted">{label}</p>
        <div className="mt-0.5 text-sm font-medium text-text">{children}</div>
      </div>
    </div>
  );
}

export function SubmissionDetailView({ submission: s, history, historyHref, actions }: {
  submission: Submission; history?: Submission[]; historyHref?: (s: Submission) => string; actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Card
        title={`Version ${s.version} · ${s.project.title}`}
        description={<>{s.trainee.full_name} · {s.trainee.trainee_code} · submitted <DateTime value={s.submitted_at} /></>}
        actions={<div className="flex gap-2"><StatusBadge kind="submission" value={s.status} />{s.is_late && <StatusBadge kind="late" value="late" />}</div>}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Evidence icon={<VideoCamera />} label="Video">{s.video_url ? <ExternalLink href={s.video_url}>{s.video_url}</ExternalLink> : "—"}</Evidence>
          <Evidence icon={<LinkIcon />} label="Report link">{s.report_url ? <ExternalLink href={s.report_url}>{s.report_url}</ExternalLink> : "—"}</Evidence>
          <Evidence icon={<FileText />} label="File">{s.file ? <DownloadButton submission={s} /> : "—"}</Evidence>
          <Evidence icon={<Clock />} label="Logbook hours"><span className="tabular-nums">{s.logbook_hours != null ? String(s.logbook_hours) : "—"}</span></Evidence>
          <Evidence icon={<CurrencyInr />} label="Bill of materials"><span className="tabular-nums">{formatInr(s.bom_cost_inr)}</span></Evidence>
          <Evidence icon={<Note />} label="Note">{s.note ? <span className="font-normal whitespace-pre-wrap">{s.note}</span> : "—"}</Evidence>
        </div>
        {s.evaluation && <div className="mt-5"><EvaluationView evaluation={s.evaluation} /></div>}
      </Card>
      {actions}
      {history && history.length > 1 && (
        <Card title="Version history" description={`${history.length} versions`}>
          <ol className="relative space-y-4 border-l-2 border-border pl-5">
            {history.map((h) => (
              <li key={h.id} className="relative">
                <span aria-hidden className={cx(
                  "absolute top-1 -left-[1.6rem] size-3 rounded-full border-2 border-surface",
                  h.id === s.id ? "bg-primary ring-4 ring-primary/15" : "bg-border-strong",
                )} />
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span>
                    <span className="font-semibold">Version {h.version}</span>
                    {h.id === s.id && <span className="ml-1.5 text-xs font-semibold text-primary">(viewing)</span>}
                    <span className="block text-xs text-muted"><DateTime value={h.submitted_at} /></span>
                  </span>
                  <span className="flex items-center gap-2">
                    <StatusBadge kind="submission" value={h.status} />
                    {h.evaluation?.grade && <StatusBadge kind="grade" value={h.evaluation.grade} />}
                    {historyHref && h.id !== s.id && (
                      <Link className="inline-flex items-center gap-0.5 font-semibold text-primary hover:underline" to={historyHref(h)}>
                        View<span className="sr-only"> version {h.version}</span> <CaretRight aria-hidden size={12} />
                      </Link>
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ol>
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
      const text = (
        <span className="flex items-center gap-2.5">
          <Avatar name={r.trainee.full_name} size="sm" />
          <span className="min-w-0">
            <span className={cx("block font-semibold", href && "text-primary group-hover:underline")}>{r.trainee.full_name}</span>
            <span className="block text-xs text-muted">{r.trainee.trainee_code} · {r.trainee.trade.name}</span>
          </span>
        </span>
      );
      return href ? <Link className="group rounded" to={href}>{text}</Link> : text;
    } }] : []),
    { key: "project", header: "Project", sort: "project_title", cell: (r) => r.project ? <span className="block min-w-40">{r.project.title}<span className="block text-xs text-muted">{r.project.project_code}</span></span> : <span className="text-muted">—</span> },
    ...(showSupervisorColumn ? [{ key: "sup", header: "Supervisor", cell: (r: ProgressRow) => r.supervisor?.full_name ?? "—" }] : []),
    { key: "match", header: "Match", sort: "-match_score", cell: (r) => <span className="flex flex-wrap items-center gap-1.5 tabular-nums">{formatScore(r.allocation?.match_score)}{r.allocation?.is_override && <StatusBadge kind="allocationSource" value="override" />}</span> },
    { key: "progress", header: "Status", cell: (r) => <span className="flex flex-wrap gap-1"><StatusBadge kind="progress" value={r.progress} />{r.latest_submission?.is_late && <StatusBadge kind="late" value="late" />}</span> },
    { key: "version", header: "Latest version", cell: (r) => r.latest_submission ? <span className="tabular-nums">v{r.latest_submission.version}</span> : "—" },
    { key: "score", header: "Score", sort: "-total_score", cell: (r) => r.evaluation ? <span className="flex items-center gap-1.5"><span className="font-semibold tabular-nums">{r.evaluation.total_score}</span>{r.evaluation.grade && <StatusBadge kind="grade" value={r.evaluation.grade} />}</span> : "—" },
  ];
  return (
    <>
      <DataTable rows={rows} columns={cols} rowKey={(r) => r.trainee.id} sort={sort} onSortChange={onSortChange} caption="Progress" />
      {onPageChange && <Pagination meta={meta} onPageChange={onPageChange} />}
    </>
  );
}
