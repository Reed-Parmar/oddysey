import {
  ArrowCounterClockwise, ArrowRight, ChartBar, CheckCircle, ClipboardText, Clock, FileMagnifyingGlass, FlagCheckered, FolderSimple,
  Hourglass, Info, ListChecks, Target, UploadSimple, UsersThree,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Project, ProgressRow } from "@/api/types";
import {
  DateTime, EmptyState, ErrorState, LoadingState, Meter, PageHeader, Skeleton, StackedBar, StatCard, StatusBadge,
} from "@/components/shared";
import { Pipeline, type PipelineStage, type PipelineStatus } from "@/components/shared/Pipeline";
import { Alert, Card, buttonStyles } from "@/components/ui";
import { label } from "@/lib/statusLabels";

import { NoCycleState, PersonCell, SupervisorProjectCard, useCycleState, useMyProjects } from "../common";
import type { Grade } from "../lib/grade";
import { AlertsPanel } from "@/features/shared/Autopilot";

const GRADES: Grade[] = ["A1", "A", "B+", "B", "C", "D"];

type CountQuery = { isLoading: boolean; error: unknown; refetch: () => unknown; data?: number };

/** KPI tile backed by a count query: skeleton while loading, retry hint on error. */
function CountTile({ label: title, query, to, icon, tone, hint }: {
  label: string; query: CountQuery; to: string; icon: ReactNode; tone: "primary" | "warning" | "danger" | "success"; hint: string;
}) {
  if (query.error) {
    return (
      <StatCard label={title} icon={icon} tone={tone} value="—"
        hint={<>Could not load. <button type="button" className="font-semibold text-primary underline" onClick={() => void query.refetch()}>Try again</button></>} />
    );
  }
  return (
    <StatCard label={title} icon={icon} tone={tone} to={to} hint={hint}
      value={query.isLoading ? (
        <><span aria-hidden className="inline-block h-8 w-14 animate-pulse rounded-md bg-neutral-bg align-middle" /><span className="sr-only">Loading</span></>
      ) : (query.data ?? 0)} />
  );
}

function useCount(key: readonly unknown[], fn: () => Promise<{ meta: { total: number } }>, enabled: boolean) {
  return useQuery({ queryKey: key, queryFn: fn, enabled, select: (r) => r.meta.total });
}

async function fetchAllEvaluated(): Promise<ProgressRow[]> {
  const rows: ProgressRow[] = [];
  for (let page = 1; page <= 50; page++) {
    const res = await call(api.GET("/api/v1/progress", { params: { query: { progress: "evaluated", page_size: 100, page } } }));
    rows.push(...res.data);
    if (page * 100 >= res.meta.total) break;
  }
  return rows;
}

function ProjectsSection() {
  const projects = useMyProjects();
  if (projects.isLoading) return <LoadingState />;
  if (projects.error) return <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />;
  const list = projects.data?.data ?? [];
  if (!list.length) return <EmptyState icon={<FolderSimple />} title="No projects are assigned to you yet." />;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      {list.map((p) => <SupervisorProjectCard key={p.id} project={p} />)}
    </div>
  );
}

function ProjectsHeading() {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="flex items-center gap-2 text-base font-semibold"><FolderSimple aria-hidden size={18} className="text-primary" /> My projects</h2>
      <Link to="/supervisor/projects" className="inline-flex items-center gap-1 text-sm font-semibold text-primary hover:underline">
        All projects <ArrowRight aria-hidden size={14} />
      </Link>
    </div>
  );
}

type FlowCounts = { allocated: number; notSubmitted: number; awaiting: number; rework: number; evaluated: number; late: number };

/** The supervisor's slice of the automated lifecycle, from the same counts the KPI tiles use. Presentation only. */
function buildFlow(projects: Project[], c: FlowCounts): PipelineStage[] {
  const ready = projects.filter((p) => p.processing_status === "ready").length;
  const failed = projects.filter((p) => p.processing_status === "failed").length;
  const running = projects.filter((p) => p.processing_status === "queued" || p.processing_status === "processing").length;
  const blocked = projects.length - ready - failed - running;
  const projStatus: PipelineStatus = !projects.length ? "idle" : failed ? "error" : running ? "active" : blocked ? "attention" : "done";
  const submittedAny = c.awaiting + c.rework + c.evaluated;
  const subStatus: PipelineStatus = !c.allocated ? "idle" : c.notSubmitted ? "waiting" : "done";
  const evalStatus: PipelineStatus = !submittedAny ? "idle" : c.awaiting ? "attention" : c.rework ? "waiting" : "done";
  const open = Math.max(0, c.allocated - c.evaluated);
  return [
    {
      key: "projects", title: "Project Analysis", icon: <FileMagnifyingGlass />, status: projStatus,
      statusLabel: { idle: "No projects yet", error: `${failed} failed`, active: `${running} processing`, attention: `${blocked} need input`, done: "All ready", waiting: undefined }[projStatus],
      metric: projects.length ? `${ready}/${projects.length}` : undefined, metricLabel: "ready",
      progress: projects.length ? ready / projects.length : undefined,
      summary: "Your projects are processed from their documents in the background. Only ready projects take part in allocation.",
      link: { to: "/supervisor/projects", label: "Open my projects" },
    },
    {
      key: "allocation", title: "Automated Allocation", icon: <Target />,
      status: c.allocated ? "done" : ready ? "waiting" : "idle",
      statusLabel: c.allocated ? `${c.allocated} allocated` : ready ? "Waiting for the next run" : "Not started",
      metric: c.allocated, metricLabel: "trainees",
      summary: "Trainees are allocated to your projects automatically, each with an itemised match explanation. A trainee can reject once before submitting and is replaced by the next-ranked match.",
      link: { to: "/supervisor/progress", label: "View progress" },
    },
    {
      key: "submission", title: "Student Submission", icon: <UploadSimple />, status: subStatus,
      statusLabel: { idle: "Not started", waiting: `${c.notSubmitted} not submitted`, done: "All submitted", active: undefined, attention: undefined, error: undefined }[subStatus],
      metric: c.allocated ? `${submittedAny}/${c.allocated}` : undefined, metricLabel: "submitted",
      progress: c.allocated ? submittedAny / c.allocated : undefined,
      summary: "Trainees submit a written report; versions continue through the rework loop.",
      details: [{ label: "Late", value: c.late }],
      link: { to: "/supervisor/progress", label: "View progress" },
    },
    {
      key: "evaluation", title: "Evaluation", icon: <ClipboardText />, status: evalStatus,
      statusLabel: { idle: "Not started", attention: `${c.awaiting} to evaluate`, waiting: `${c.rework} in rework`, done: "Up to date", active: undefined, error: undefined }[evalStatus],
      metric: c.awaiting, metricLabel: "in your queue",
      summary: "Each report arrives with an automated evaluation and an originality analysis. Review them, then finalise or request rework.",
      details: [{ label: "Awaiting evaluation", value: c.awaiting }, { label: "Rework requested", value: c.rework }],
      link: { to: "/supervisor/submissions?status=submitted&versions=latest", label: "Open evaluation queue" },
    },
    {
      key: "completion", title: "Completion", icon: <FlagCheckered />,
      status: !c.allocated || !c.evaluated ? "idle" : open ? "waiting" : "done",
      statusLabel: !c.allocated || !c.evaluated ? "No results yet" : open ? `${open} still open` : "All evaluated",
      metric: c.allocated ? `${Math.round((c.evaluated / c.allocated) * 100)}%` : undefined, metricLabel: "complete",
      progress: c.allocated ? c.evaluated / c.allocated : undefined,
      summary: "A trainee is complete once their latest version is evaluated.",
    },
  ];
}

function FlowSection({ counts }: { counts: FlowCounts | null }) {
  const projects = useMyProjects();
  if (!counts || projects.isLoading) return <Skeleton className="h-56 rounded-2xl" />;
  if (projects.error) return null;
  return (
    <section aria-labelledby="flow-title">
      <Pipeline label="Your trainees through the lifecycle" stages={buildFlow(projects.data?.data ?? [], counts)} columns={5}
        toolbar={
          <div className="min-w-0">
            <h2 id="flow-title" className="text-base font-semibold text-text">Your trainees in the pipeline</h2>
            <p className="text-xs text-muted">Allocation and report analysis run automatically. Your step is evaluation.</p>
          </div>
        } />
    </section>
  );
}

const QUEUE_PARAMS = { status: "submitted", sort: "submitted_at", page_size: 5 } as const;

/** Oldest submissions still waiting for an evaluation, with a direct "Evaluate" action. */
function EvaluationQueue({ enabled, total }: { enabled: boolean; total?: number }) {
  const q = useQuery({
    queryKey: qk.submissions.list(QUEUE_PARAMS),
    queryFn: () => call(api.GET("/api/v1/submissions", { params: { query: QUEUE_PARAMS } })),
    enabled,
  });
  const rows = q.data?.data ?? [];
  return (
    <Card
      flush
      icon={<ListChecks />}
      title="Evaluation queue"
      description="Oldest first, so nobody waits too long."
      actions={<Link to="/supervisor/submissions?status=submitted&versions=latest" className={buttonStyles("secondary", "sm")}>Open queue{total ? ` (${total})` : ""}</Link>}
    >
      {q.isLoading ? (
        <div className="space-y-3 px-5 pb-5">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
      ) : q.error ? (
        <div className="px-5 pb-5"><ErrorState error={q.error} onRetry={() => void q.refetch()} /></div>
      ) : !rows.length ? (
        <div className="flex items-center gap-3 border-t border-border px-5 py-6 text-sm text-muted">
          <CheckCircle aria-hidden size={20} className="shrink-0 text-success" />
          Nothing is waiting for evaluation. You are all caught up.
        </div>
      ) : (
        <ul className="divide-y divide-border border-t border-border">
          {rows.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
              <PersonCell name={s.trainee.full_name} meta={<>{s.project.project_code} · {s.project.title}</>} />
              <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
                <span className="inline-flex items-center gap-1"><Clock aria-hidden size={14} /> v{s.version} · <DateTime value={s.submitted_at} /></span>
                {s.is_late && <StatusBadge kind="late" value="late" />}
                <Link to={`/supervisor/submissions/${s.id}`} className={buttonStyles("primary", "sm")}>
                  Evaluate<span className="sr-only"> {s.trainee.full_name}, version {s.version}</span>
                  <ArrowRight aria-hidden size={14} />
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const GRADE_TONE = { success: "success", info: "primary", warning: "warning", danger: "danger", neutral: "neutral" } as const;

export function DashboardPage() {
  const { cycle, visible, isLoading, error, refetch } = useCycleState();

  const P_SUB = { status: "submitted", page_size: 1 } as const;
  const P_REWORK = { status: "rework_requested", page_size: 1 } as const;
  const P_ALLOC = { page_size: 1 } as const;
  const P_LATE = { late_only: true, page_size: 1 } as const;
  const P_NOT_SUBMITTED = { progress: "allocated", page_size: 1 } as const;
  const P_PROG_SUB = { progress: "submitted", page_size: 1 } as const;
  const P_PROG_REWORK = { progress: "rework_requested", page_size: 1 } as const;

  const pending = useCount(qk.submissions.list(P_SUB), () => call(api.GET("/api/v1/submissions", { params: { query: P_SUB } })), visible);
  const rework = useCount(qk.submissions.list(P_REWORK), () => call(api.GET("/api/v1/submissions", { params: { query: P_REWORK } })), visible);
  const allocated = useCount(qk.allocations.list(P_ALLOC), () => call(api.GET("/api/v1/allocations", { params: { query: P_ALLOC } })), visible);
  const late = useCount(qk.progress.list(P_LATE), () => call(api.GET("/api/v1/progress", { params: { query: P_LATE } })), visible);
  const notSubmitted = useCount(qk.progress.list(P_NOT_SUBMITTED), () => call(api.GET("/api/v1/progress", { params: { query: P_NOT_SUBMITTED } })), visible);
  const progSubmitted = useCount(qk.progress.list(P_PROG_SUB), () => call(api.GET("/api/v1/progress", { params: { query: P_PROG_SUB } })), visible);
  const progRework = useCount(qk.progress.list(P_PROG_REWORK), () => call(api.GET("/api/v1/progress", { params: { query: P_PROG_REWORK } })), visible);
  const grades = useQuery({ queryKey: qk.progress.list({ progress: "evaluated", all: true }), queryFn: fetchAllEvaluated, enabled: visible });

  let body: ReactNode;
  if (isLoading) body = <LoadingState />;
  else if (error) body = <ErrorState error={error} onRetry={() => void refetch()} />;
  else if (!cycle) body = <NoCycleState />;
  else {
    const counts = new Map<string, number>();
    for (const r of grades.data ?? []) if (r.evaluation?.grade) counts.set(r.evaluation.grade, (counts.get(r.evaluation.grade) ?? 0) + 1);
    const gradeRows = GRADES.filter((g) => counts.get(g));
    const evaluatedTotal = grades.data?.length ?? 0;
    const breakdownLoading = notSubmitted.isLoading || progSubmitted.isLoading || progRework.isLoading || grades.isLoading;
    const breakdownError = notSubmitted.error || progSubmitted.error || progRework.error;
    body = (
      <div className="space-y-6">
        {cycle.status === "archived" && (
          <Alert variant="info" icon={<Info />}>This cycle is archived. Evaluations are closed; records are read-only.</Alert>
        )}
        <FlowSection counts={
          [allocated, notSubmitted, pending, rework, late].some((q) => q.data == null) || grades.data == null ? null : {
            allocated: allocated.data ?? 0, notSubmitted: notSubmitted.data ?? 0, awaiting: pending.data ?? 0,
            rework: rework.data ?? 0, evaluated: evaluatedTotal, late: late.data ?? 0,
          }} />
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <CountTile label="Pending evaluations" query={pending} to="/supervisor/submissions?status=submitted&versions=latest" icon={<Hourglass />} tone="primary" hint="Open evaluation queue" />
          <CountTile label="Rework requested" query={rework} to="/supervisor/submissions?status=rework_requested&versions=latest" icon={<ArrowCounterClockwise />} tone="warning" hint="View rework" />
          <CountTile label="Allocated trainees" query={allocated} to="/supervisor/progress" icon={<UsersThree />} tone="success" hint="View progress" />
          <CountTile label="Late submissions" query={late} to="/supervisor/progress?late_only=true" icon={<Clock />} tone="danger" hint="View late" />
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <EvaluationQueue enabled={visible} total={pending.data} />

          <Card icon={<ChartBar />} title="Trainee progress" description="Where every trainee on your projects stands.">
            {breakdownLoading ? <Skeleton className="h-16 rounded-lg" /> : breakdownError ? (
              <ErrorState error={breakdownError} onRetry={() => { void notSubmitted.refetch(); void progSubmitted.refetch(); void progRework.refetch(); }} />
            ) : (
              <StackedBar
                label="Trainee progress"
                segments={[
                  { label: "Not submitted", value: notSubmitted.data ?? 0, className: "bg-subtle" },
                  { label: "Awaiting evaluation", value: progSubmitted.data ?? 0, className: "bg-primary" },
                  { label: "Rework requested", value: progRework.data ?? 0, className: "bg-warning" },
                  { label: "Evaluated", value: evaluatedTotal, className: "bg-success" },
                ]}
              />
            )}

            <h3 className="mt-6 mb-3 text-sm font-semibold text-text">Grade distribution</h3>
            {grades.isLoading ? <Skeleton className="h-24 rounded-lg" /> : grades.error ? (
              <ErrorState error={grades.error} onRetry={() => void grades.refetch()} />
            ) : gradeRows.length ? (
              <ul className="space-y-3">
                {gradeRows.map((g) => {
                  const [text, variant] = label("grade", g);
                  return (
                    <li key={g}>
                      <Meter label={text} value={counts.get(g) ?? 0} max={evaluatedTotal} tone={GRADE_TONE[variant]} valueLabel={`${counts.get(g)} of ${evaluatedTotal}`} />
                    </li>
                  );
                })}
              </ul>
            ) : <p className="text-sm text-muted">No evaluations yet.</p>}
          </Card>
        </div>

        <section>
          <ProjectsHeading />
          <ProjectsSection />
        </section>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={cycle ? <span className="inline-flex flex-wrap items-center gap-2">{cycle.name} <StatusBadge kind="cycle" value={cycle.status} /></span> : undefined}
        actions={visible ? (
          <Link to="/supervisor/submissions?status=submitted&versions=latest" className={buttonStyles("primary")}>
            <ListChecks aria-hidden size={16} /> Evaluation queue
          </Link>
        ) : undefined}
      />
      <div className="mb-6"><AlertsPanel /></div>
      {body}
    </>
  );
}
