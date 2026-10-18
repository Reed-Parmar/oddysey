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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { API_BASE, api, authHeaders, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Allocation, Analysis, PageMeta, ProgressRow, Project, Resume, Submission, Trainee } from "@/api/types";
import {
  Avatar, DataTable, DateTime, EmptyState, ErrorState, KeyValue, LoadingState, Pagination, ScoreBar, SkillChips,
  StatusBadge, useToast, type Column,
} from "@/components/shared";
import { Button, Card, cx } from "@/components/ui";
import { useAuth } from "@/auth/AuthProvider";
import { formatBytes, formatInr, formatScore } from "@/lib/format";
import { MatchReason } from "./MatchReason";
import { PlagiarismReport } from "./PlagiarismReport";

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

export const tradeNames = (p: Project) => p.target_trades.map((t) => t.name).join(", ") || "Not set";

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
        {badge ?? <StatusBadge kind="processing" value={project.processing_status} />}
      </div>
      <div className="mt-4 flex flex-wrap gap-1.5">
        {project.difficulty && <StatusBadge kind="difficulty" value={project.difficulty} />}
        <Tag><Wrench aria-hidden size={12} />{tradeNames(project)}</Tag>
        {project.min_practical_score > 0 && <Tag>Verified practical ≥ {formatScore(project.min_practical_score)}%</Tag>}
        {project.stats && (
          <Tag><UsersThree aria-hidden size={12} />{project.stats.working_individually} working individually</Tag>
        )}
      </div>
      <span className="mt-auto inline-flex items-center gap-1 pt-4 text-sm font-semibold text-primary">
        View details <CaretRight aria-hidden size={14} className="transition-transform group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}

/** Opens the project document: a 5-minute signed URL for uploads, or the legacy https link. */
export function ProjectDocumentButton({ project }: { project: Project }) {
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => call(api.GET("/api/v1/projects/{project_id}/document-url", { params: { path: { project_id: project.id } } })),
    onSuccess: (res) => window.open(res.data.url, "_blank", "noopener,noreferrer"),
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!project.document && !project.problem_doc_url) return <span className="text-muted">No document yet</span>;
  return (
    <Button size="sm" variant="secondary" icon={<FileText />} loading={m.isPending} onClick={() => m.mutate()}>
      {project.document ? `Open ${project.document.name}` : "Open problem statement"}
    </Button>
  );
}

export function ProjectDetailView({ project, actions }: { project: Project; actions?: ReactNode }) {
  const supervisor = project.supervisor
    ? `${project.supervisor.full_name}${project.supervisor.department ? ` (${project.supervisor.department})` : ""}`
    : "Not assigned yet";
  return (
    <Card
      title={<span>{project.title} <span className="text-sm font-normal text-muted">· {project.project_code}</span></span>}
      actions={actions}
    >
      <KeyValue items={[
        ["Status", <span key="s" className="flex flex-wrap gap-1.5"><StatusBadge kind="processing" value={project.processing_status} /><StatusBadge kind="project" value={project.status} /></span>],
        ["Target trades", tradeNames(project)],
        ["Difficulty", project.difficulty ? <StatusBadge key="d" kind="difficulty" value={project.difficulty} /> : "Not set"],
        ["Verified practical requirement", project.min_practical_score > 0 ? `${formatScore(project.min_practical_score)}% (verified marks only)` : "None"],
        ["Minimum match threshold", project.min_match_score > 0 ? `${formatScore(project.min_match_score)} / 100` : "None (0)"],
        ...(project.stats ? [
          ["Number of trainees working individually", String(project.stats.working_individually)] as [string, string],
          ["Rejections (history)", String(project.stats.rejected_total)] as [string, string],
        ] : []),
        ["Deadline", <span key="dl"><DateTime value={project.effective_deadline} />{!project.deadline && <span className="text-xs text-muted"> (cycle default)</span>}</span>],
        ["Category / sponsor goal", project.category ?? "—"],
        ["Supervisor", supervisor],
        ["Prerequisite skills", project.skills.length ? <SkillChips key="k" skills={project.skills} /> : "—"],
        ["Project document", <ProjectDocumentButton key="doc" project={project} />],
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

type Step = { stage: string; title: string; detail: string; generated?: boolean };

/** Ordered execution guide generated from the brief (labelled as generated where applicable). */
export function ProjectGuide({ project }: { project: Project }) {
  const g = (project.generated ?? {}) as {
    steps?: Step[]; deliverables?: string[]; tools_materials?: string[]; timeline?: { milestone: string; offset_pct: number }[];
    assumptions?: string[]; source?: string;
  };
  if (!g.steps?.length) return <p className="text-sm text-muted">The project guide is being prepared from the project document.</p>;
  return (
    <div className="flex flex-col gap-5 text-sm">
      <ol className="relative space-y-4 border-l-2 border-border pl-5">
        {g.steps.map((s, i) => (
          <li key={s.stage} className="relative">
            <span aria-hidden className="absolute top-0.5 -left-[1.95rem] inline-flex size-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-fg">{i + 1}</span>
            <p className="font-semibold text-text">
              {s.title}
              {s.generated && <span className="ml-2 inline-flex items-center gap-0.5 rounded bg-accent-soft px-1.5 text-[11px] font-semibold text-accent-ink"><Sparkle aria-hidden size={10} weight="fill" />Generated</span>}
            </p>
            <p className="mt-0.5 leading-relaxed whitespace-pre-wrap text-muted">{s.detail}</p>
          </li>
        ))}
      </ol>
      {!!g.deliverables?.length && (
        <div><h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Deliverables</h3>
          <ul className="list-disc space-y-1 pl-5">{g.deliverables.map((d) => <li key={d}>{d}</li>)}</ul></div>
      )}
      {!!g.tools_materials?.length && (
        <div><h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Tools and materials</h3>
          <SkillChips skills={g.tools_materials.map((name) => ({ name }))} /></div>
      )}
      {!!g.timeline?.length && (
        <div>
          <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted uppercase">Suggested timeline (proposal)</h3>
          <ul className="space-y-1">{g.timeline.map((t) => <li key={t.milestone} className="flex justify-between gap-3"><span>{t.milestone}</span><span className="text-muted tabular-nums">by {t.offset_pct}% of the time</span></li>)}</ul>
        </div>
      )}
      {!!g.assumptions?.length && <p className="text-xs text-muted">Assumptions: {g.assumptions.join(" ")}</p>}
    </div>
  );
}

// ---------------------------------------------------------------- trainees

export function TraineeProfileView({ trainee, showSensitive }: { trainee: Trainee; showSensitive?: boolean }) {
  const trades = trainee.trades.map((t) => t.name).join(", ");
  return (
    <Card
      title={
        <span className="flex items-center gap-3">
          <Avatar name={trainee.full_name} />
          <span>
            {trainee.full_name}
            <span className="block text-sm font-normal text-muted">{trainee.trainee_code} · {trades}</span>
          </span>
        </span>
      }
      actions={<span className="flex flex-wrap gap-1.5"><StatusBadge kind="assessment" value={trainee.assessment_status} /><StatusBadge kind="matchMode" value={trainee.match_mode} /></span>}
    >
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        {([["Theory score", trainee.scores.theory, "Theory"], ["Practical score", trainee.scores.practical, "Practical"], ["Safety compliance", trainee.scores.safety, "Safety"]] as const).map(([k, v, l]) => (
          <div key={k} className="rounded-lg border border-border bg-surface-2 p-3">
            <p className="text-xs font-medium text-muted">{k} <span className="text-[11px]">(verified)</span></p>
            <div className="mt-1.5"><ScoreBar value={v} label={l} tone="auto" /></div>
          </div>
        ))}
      </div>
      <KeyValue items={[
        ["Trades", trades],
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

// ---------------------------------------------------------------- matching explanation

/** "Why this project was allocated": the persisted factors, mode and constraints of one allocation. */
export function MatchExplanation({ allocation }: { allocation: Allocation }) {
  return <MatchReason allocation={allocation} audience="staff" />;
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
        actions={<div className="flex flex-wrap gap-2"><StatusBadge kind="submission" value={s.status} /><StatusBadge kind="analysis" value={s.analysis_status} />{s.is_late && <StatusBadge kind="late" value="late" />}</div>}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Evidence icon={<VideoCamera />} label="Video">{s.video_url ? <ExternalLink href={s.video_url}>{s.video_url}</ExternalLink> : "—"}</Evidence>
          <Evidence icon={<LinkIcon />} label="Report link">{s.report_url ? <ExternalLink href={s.report_url}>{s.report_url}</ExternalLink> : "—"}</Evidence>
          <Evidence icon={<FileText />} label="File">{s.file ? <DownloadButton submission={s} /> : "—"}</Evidence>
          <Evidence icon={<Clock />} label="Logbook hours"><span className="tabular-nums">{s.logbook_hours != null ? String(s.logbook_hours) : "—"}</span></Evidence>
          <Evidence icon={<CurrencyInr />} label="Bill of materials"><span className="tabular-nums">{formatInr(s.bom_cost_inr)}</span></Evidence>
          <Evidence icon={<Note />} label="Note">{s.note ? <span className="font-normal whitespace-pre-wrap">{s.note}</span> : "—"}</Evidence>
        </div>
        <p className="mt-4 flex flex-wrap items-center gap-2 text-sm"><span className="text-muted">Automated report evaluation:</span><ReportScore summary={s.report_evaluation} /><span className="text-xs text-muted">· deadline <DateTime value={s.deadline} /></span></p>
        {s.evaluation && <div className="mt-5"><h3 className="mb-2 text-sm font-semibold">Verified practical evaluation (supervisor)</h3><EvaluationView evaluation={s.evaluation} /></div>}
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

// ---------------------------------------------------------------- report evaluation + originality (ADR-017)

type Criterion = { key: string; label: string; max_points: number; points: number; explanation?: string; evidence?: { excerpt: string; location: string }[] };
type Suggestion = { priority: number; issue: string; evidence: string; why_it_matters: string; steps: string[]; expected_benefit: string };
type Passage = { target_excerpt: string; source_excerpt: string | null; tokens: number };
type Source = { source_id: string | null; label: string; matched_tokens: number; coverage_pct: number; passages: Passage[] };

/** Compact automated-evaluation summary for lists and cards. */
export function ReportScore({ summary }: { summary: Submission["report_evaluation"] }) {
  if (!summary) return <span className="text-muted">—</span>;
  if (summary.total == null) return <span className="text-xs text-muted">{summary.status === "unavailable" ? "Awaiting review" : summary.status}</span>;
  const total = summary.effective_total ?? summary.total;
  const grade = summary.effective_grade ?? summary.grade;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="font-semibold tabular-nums">{total} / {summary.max_total}</span>
      {grade && <StatusBadge kind="grade" value={grade} />}
      {summary.amended && <span className="text-xs text-muted">(supervisor-amended)</span>}
    </span>
  );
}

function Section({ title, children, note }: { title: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="border-t border-border pt-4 first:border-t-0 first:pt-0">
      <h3 className="text-sm font-semibold text-text">{title}</h3>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
      <div className="mt-2 text-sm">{children}</div>
    </section>
  );
}

export function useAnalysis(submissionId: string, poll: boolean) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: qk.submissions.analysis(submissionId),
    queryFn: () => call(api.GET("/api/v1/submissions/{submission_id}/analysis", { params: { path: { submission_id: submissionId } } })),
    refetchInterval: (q) => {
      const st = q.state.data?.data?.status;
      const waiting = q.state.error instanceof ApiError && q.state.error.status === 404;
      return poll && (waiting || st === "queued" || st === "extracting" || st === "analysing" || st === "retrying") ? 4000 : false;
    },
    retry: (n, e) => !(e instanceof Error && "status" in e && (e as { status: number }).status === 404) && n < 2,
  });
  const status = query.data?.data.status;
  useEffect(() => {
    if (!poll || !status || ["queued", "extracting", "analysing", "retrying"].includes(status)) return;
    // Analysis updates the submission outcome in the worker, outside the browser's mutations.
    void qc.invalidateQueries({ queryKey: ["submissions", "list"] });
    void qc.invalidateQueries({ queryKey: qk.submissions.detail(submissionId) });
    void qc.invalidateQueries({ queryKey: qk.progress.all() });
    void qc.invalidateQueries({ queryKey: qk.reports.all() });
  }, [poll, qc, status, submissionId]);
  return query;
}

/** Opens the printable HTML export (authenticated fetch → blob URL; the same persisted findings as the screen). */
export function ExportReportButton({ submissionId }: { submissionId: string }) {
  const toast = useToast();
  const m = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/submissions/${submissionId}/analysis/export`, { headers: await authHeaders() });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      return URL.createObjectURL(await res.blob());
    },
    onSuccess: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return <Button size="sm" variant="secondary" icon={<DownloadSimple />} loading={m.isPending} onClick={() => m.mutate()}>Printable report</Button>;
}

/**
 * Automated report evaluation + improvements, plus (staff only) the Plagiarism & Originality Analysis, similarity
 * and AI-writing sections, review history and the printable export. Students never see originality findings: the
 * role is checked here (deny by default), not only whether the API sent the data.
 */
export function AnalysisReport({ analysis: a, showExport }: { analysis: Analysis; showExport?: boolean }) {
  const role = useAuth().user?.role;
  const staff = role === "supervisor" || role === "admin";
  const o = (a.originality ?? {}) as {
    status?: string; overlap_pct?: number | null; overlap_reason?: string | null; method?: string; formula?: string;
    tokens?: { eligible: number; excluded: number; excluded_pct: number; excluded_by_reason: Record<string, number> };
    sources?: Source[]; attention_band?: string | null; bands_version?: string; finding?: string; finding_reason?: string;
    self_reuse?: { overlap_pct: number | null; note: string }; limitations?: string[]; code?: { reason: string };
  };
  const ev = (a.evaluation ?? {}) as {
    status?: string; status_reason?: string | null; total?: number | null; max_total?: number; grade?: string | null;
    confidence?: string | null; outcome?: string | null; suggestions?: Suggestion[]; checklist?: string[]; limitations?: string[];
  };
  const criteria = a.effective_criteria as Criterion[];
  const corpus = (a.corpus ?? {}) as { scope?: string; items?: number };
  const limitations = [...(staff ? o.limitations ?? [] : []), ...(ev.limitations ?? [])];
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge kind="analysis" value={a.status} />
        <span className="text-xs text-muted">Version {a.submission_version} · revision {a.revision} · {a.pipeline_version}</span>
        {a.finished_at && <span className="text-xs text-muted">· <DateTime value={a.finished_at} /></span>}
        {staff && showExport && <ExportReportButton submissionId={a.submission_id} />}
      </div>
      {a.status_reason && <p className="rounded-lg border border-warning/30 bg-warning-bg px-3 py-2 text-sm text-warning">{a.status_reason}</p>}

      <Section title="Automated report evaluation" note="Scores only what the report documents. It does not verify workmanship, a working device, observed safety practice or a viva.">
        {ev.total == null ? (
          <p className="text-muted">{ev.status === "unavailable" ? "Automated evaluation is not configured; a supervisor will review this report." : ev.status_reason ?? "Not evaluated yet."}</p>
        ) : (
          <>
            <p className="mb-2 flex flex-wrap items-center gap-2">
              <span className="font-heading text-lg font-semibold tabular-nums">{criteria.reduce((s, c) => s + c.points, 0)} / {ev.max_total ?? 100}</span>
              {ev.grade && <StatusBadge kind="grade" value={ev.grade} />}
              <span className="text-xs text-muted">Automated report grade{a.amended ? " (supervisor-amended)" : ""}{ev.confidence ? ` · confidence ${ev.confidence}` : ""}</span>
            </p>
            <ul className="space-y-3">
              {criteria.map((c) => (
                <li key={c.key}>
                  <div className="flex items-baseline justify-between gap-3"><span className="font-medium">{c.label}</span><span className="tabular-nums"><span className="font-semibold">{c.points}</span><span className="text-muted"> / {c.max_points}</span></span></div>
                  {c.explanation && <p className="text-xs text-muted">{c.explanation}</p>}
                  {c.evidence?.map((e, i) => <blockquote key={i} className="mt-1 border-l-2 border-primary/40 pl-2 text-xs italic">“{e.excerpt}” <span className="not-italic text-muted">({e.location})</span></blockquote>)}
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      {staff && (
        <>
          <Section title="Plagiarism & Originality Report" note="Potential overlap that needs contextual review. Shared brief and guide text, quotations and references are not counted.">
            <PlagiarismReport submissionId={a.submission_id} />
            {o.self_reuse?.overlap_pct != null && <p className="mt-3 text-xs text-muted">Reuse of the trainee's own earlier versions: {o.self_reuse.overlap_pct}% (reported separately, not counted as overlap).</p>}
            <p className="mt-1 text-xs text-muted">Compared with: {corpus.scope} ({corpus.items ?? 0} items).</p>
          </Section>

          <Section title="Concept and code similarity">
            <p className="text-muted">{(a.semantic as { reason?: string } | null)?.reason ?? "Not assessed."}</p>
            <p className="mt-1 text-muted">{o.code?.reason ?? "Code similarity not assessed."}</p>
          </Section>
          <Section title="AI-writing assessment">
            <p className="text-muted">{(a.ai_writing as { reason?: string } | null)?.reason ?? "Not available."}</p>
          </Section>
        </>
      )}

      <Section title="How to improve" note="Specific to this project. Improvement guidance is not a misconduct finding.">
        {ev.suggestions?.length ? (
          <ol className="space-y-3">
            {ev.suggestions.map((s) => (
              <li key={s.priority} className="rounded-lg border border-border p-3">
                <p className="font-semibold">{s.priority}. {s.issue}</p>
                {s.evidence && <p className="text-xs text-muted">Evidence: {s.evidence}</p>}
                <p className="mt-1 text-xs">Why it matters: {s.why_it_matters}</p>
                {!!s.steps.length && <ul className="mt-1 list-disc pl-5 text-xs">{s.steps.map((x) => <li key={x}>{x}</li>)}</ul>}
                {s.expected_benefit && <p className="mt-1 text-xs text-muted">Expected benefit: {s.expected_benefit}</p>}
              </li>
            ))}
          </ol>
        ) : <p className="text-muted">No suggestions recorded.</p>}
        {!!ev.checklist?.length && <ul className="mt-3 space-y-1">{ev.checklist.map((c) => <li key={c}>☐ {c}</li>)}</ul>}
      </Section>

      {staff && a.reviews.length > 0 && (
        <Section title="Review history">
          <ul className="space-y-1.5">{a.reviews.map((r) => <li key={r.id}><DateTime value={r.created_at} /> · {r.reviewer}: <span className="font-medium">{r.action.replace("_", " ")}</span> — {r.note}</li>)}</ul>
        </Section>
      )}
      {limitations.length > 0 && (
        <Section title="Limitations">
          <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted">{limitations.map((l) => <li key={l}>{l}</li>)}</ul>
        </Section>
      )}
    </div>
  );
}

const REVIEW_ACTIONS = [
  ["confirm", "Confirm findings"], ["annotate", "Add note"], ["request_explanation", "Ask trainee to explain"],
  ["request_rework", "Request rework"], ["amend", "Amend scores"], ["lift_rework", "Lift plagiarism rework"],
] as const;

/** Supervisor/admin review: keeps the automated result and adds a history entry (amendments need a reason). */
export function ReviewActions({ analysis, submissionId }: { analysis: Analysis; submissionId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [action, setAction] = useState<(typeof REVIEW_ACTIONS)[number][0]>("confirm");
  const [note, setNote] = useState("");
  const criteria = analysis.effective_criteria as Criterion[];
  const [points, setPoints] = useState<Record<string, number>>(() => Object.fromEntries(criteria.map((c) => [c.key, c.points])));
  const m = useMutation({
    mutationFn: () => call(api.POST("/api/v1/submissions/{submission_id}/analysis/review", {
      params: { path: { submission_id: submissionId } },
      body: { action, note, amended_criteria: action === "amend" ? Object.entries(points).map(([key, p]) => ({ key, points: p })) : null },
    })),
    onSuccess: async () => {
      toast.success("Review saved");
      setNote("");
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.submissions.all() }),
        qc.invalidateQueries({ queryKey: qk.progress.all() }),
        qc.invalidateQueries({ queryKey: ["originality-report", submissionId] }),
      ]);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!analysis.viewer_can_review) return null;
  const needsLong = action === "amend" || action === "request_rework" || action === "lift_rework";
  // ADR-026: offered only while the automatic plagiarism rework is in force.
  const decision = (analysis.originality as { decision?: { action?: string; lifted_at?: string } } | null)?.decision;
  const canLift = decision?.action === "auto_rework" && !decision.lifted_at;
  return (
    <Card title="Review" description="Your review is recorded alongside the automated findings; nothing is overwritten.">
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Review action">
          {REVIEW_ACTIONS.filter(([k]) => (k !== "amend" || criteria.length > 0) && (k !== "lift_rework" || canLift)).map(([k, l]) => (
            <button key={k} type="button" role="radio" aria-checked={action === k} onClick={() => setAction(k)}
              className={cx("min-h-8 rounded-full border px-3 text-sm font-medium", action === k ? "border-primary bg-primary-soft text-primary-ink" : "border-border-strong")}>{l}</button>
          ))}
        </div>
        {action === "amend" && (
          <div className="grid gap-2 sm:grid-cols-2">
            {criteria.map((c) => (
              <label key={c.key} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-1.5">
                <span>{c.label}</span>
                <input type="number" min={0} max={c.max_points} value={points[c.key] ?? 0} className="w-16 rounded border border-border-strong px-1.5 py-0.5 text-right"
                  onChange={(e) => setPoints((p) => ({ ...p, [c.key]: Math.max(0, Math.min(c.max_points, Number(e.target.value))) }))} />
              </label>
            ))}
          </div>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-semibold text-muted">{needsLong ? "Reason (at least 10 characters)" : "Note"}</span>
          <textarea className="min-h-20 rounded-lg border border-border-strong bg-surface px-3 py-2" value={note} maxLength={3000} onChange={(e) => setNote(e.target.value)} />
        </label>
        <div><Button loading={m.isPending} disabled={note.trim().length < (needsLong ? 10 : 3)} onClick={() => m.mutate()}>Save review</Button></div>
      </div>
    </Card>
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
            <span className="block text-xs text-muted">{r.trainee.trainee_code} · {r.trainee.trades.map((t) => t.name).join(", ")}</span>
          </span>
        </span>
      );
      return href ? <Link className="group rounded" to={href}>{text}</Link> : text;
    } }] : []),
    { key: "project", header: "Project", sort: "project_title", cell: (r) => r.project ? <span className="block min-w-40">{r.project.title}<span className="block text-xs text-muted">{r.project.project_code}</span></span> : <span className="text-xs text-muted">{r.waiting_reason ? <StatusBadge kind="waiting" value={r.waiting_reason} /> : "—"}</span> },
    ...(showSupervisorColumn ? [{ key: "sup", header: "Supervisor", cell: (r: ProgressRow) => r.supervisor?.full_name ?? "—" }] : []),
    { key: "match", header: "Match (min / trainee)", sort: "-match_score", cell: (r) => r.allocation ? <span className="flex flex-col tabular-nums"><span>{formatScore(r.allocation.min_match_score)} / <span className="font-semibold">{formatScore(r.allocation.match_score)}</span></span><span className="text-xs text-muted">{r.allocation.match_mode === "profile" ? "profile mode" : "full mode"}</span></span> : "—" },
    { key: "progress", header: "Status", cell: (r) => <span className="flex flex-wrap gap-1"><StatusBadge kind="progress" value={r.progress} />{r.latest_submission?.is_late && <StatusBadge kind="late" value="late" />}{r.rejections > 0 && <span className="text-xs text-muted">{r.rejections} rejected</span>}</span> },
    { key: "version", header: "Latest version", cell: (r) => r.latest_submission ? <span className="flex flex-col"><span className="tabular-nums">v{r.latest_submission.version}</span>{r.analysis_status && <StatusBadge kind="analysis" value={r.analysis_status} />}</span> : "—" },
    { key: "score", header: "Evaluation", sort: "-total_score", cell: (r) => r.evaluation ? <span className="flex flex-col gap-0.5"><span className="flex items-center gap-1.5"><span className="font-semibold tabular-nums">{r.evaluation.total_score}/{r.evaluation.max_score}</span>{r.evaluation.grade && <StatusBadge kind="grade" value={r.evaluation.grade} />}</span><span className="text-xs text-muted">{r.evaluation.score_type === "automated_report" ? "Automated report" : "Verified practical"}</span></span> : "—" },
    { key: "deadline", header: "Deadline", sort: "deadline", cell: (r) => r.deadline ? <DateTime value={r.deadline} dateOnly /> : "—" },
  ];
  return (
    <>
      <DataTable rows={rows} columns={cols} rowKey={(r) => r.trainee.id} sort={sort} onSortChange={onSortChange} caption="Progress" />
      {onPageChange && <Pagination meta={meta} onPageChange={onPageChange} />}
    </>
  );
}
