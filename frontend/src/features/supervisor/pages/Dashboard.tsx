import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { ProgressRow } from "@/api/types";
import { EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "@/components/shared";
import { Alert } from "@/components/ui";
import { ProjectCard } from "@/features/shared/views";

import { NoCycleState, useCycleState, useMyProjects } from "../common";
import type { Grade } from "../lib/grade";

const GRADES: Grade[] = ["A1", "A", "B+", "B", "C", "D"];

function StatCard({ title, to, linkLabel, query }: {
  title: string; to?: string; linkLabel?: string;
  query: { isLoading: boolean; error: unknown; refetch: () => unknown; data?: number };
}) {
  return (
    <section className="rounded-lg border border-border bg-surface p-4">
      <h2 className="text-sm text-muted">{title}</h2>
      {query.isLoading ? <LoadingState label="Counting…" /> : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <p className="mt-1 text-3xl font-semibold tabular-nums">{query.data ?? 0}</p>
      )}
      {to && <Link to={to} className="mt-2 inline-block text-sm text-primary underline">{linkLabel ?? "View"}</Link>}
    </section>
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
  if (!list.length) return <EmptyState title="No projects are assigned to you yet." />;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {list.map((p) => (
        <div key={p.id} className="flex flex-col gap-1">
          <ProjectCard project={p} to={`/supervisor/projects/${p.id}`} badge={<StatusBadge kind="project" value={p.status} />} />
          <p className="px-1 text-xs text-muted">
            Eligible trainees: {p.stats?.eligible_trainee_count ?? "—"} · Allocated: {p.stats?.allocated_count ?? "—"}
          </p>
        </div>
      ))}
    </div>
  );
}

export function DashboardPage() {
  const { cycle, visible, isLoading, error, refetch } = useCycleState();

  const P_SUB = { status: "submitted", page_size: 1 } as const;
  const P_REWORK = { status: "rework_requested", page_size: 1 } as const;
  const P_ALLOC = { page_size: 1 } as const;
  const P_LATE = { late_only: true, page_size: 1 } as const;

  const pending = useCount(qk.submissions.list(P_SUB), () => call(api.GET("/api/v1/submissions", { params: { query: P_SUB } })), visible);
  const rework = useCount(qk.submissions.list(P_REWORK), () => call(api.GET("/api/v1/submissions", { params: { query: P_REWORK } })), visible);
  const allocated = useCount(qk.allocations.list(P_ALLOC), () => call(api.GET("/api/v1/allocations", { params: { query: P_ALLOC } })), visible);
  const late = useCount(qk.progress.list(P_LATE), () => call(api.GET("/api/v1/progress", { params: { query: P_LATE } })), visible);
  const grades = useQuery({ queryKey: qk.progress.list({ progress: "evaluated", all: true }), queryFn: fetchAllEvaluated, enabled: visible });

  let body: ReactNode;
  if (isLoading) body = <LoadingState />;
  else if (error) body = <ErrorState error={error} onRetry={() => void refetch()} />;
  else if (!cycle) body = <NoCycleState />;
  else if (!visible) {
    body = (
      <div className="flex flex-col gap-4">
        <Alert variant="info" title="Allocations are not published yet">
          You can review your assigned projects now. Trainees, submissions and evaluations open once the programme team publishes allocations.
        </Alert>
        <h2 className="text-base font-semibold">My projects</h2>
        <ProjectsSection />
      </div>
    );
  } else {
    const counts = new Map<string, number>();
    for (const r of grades.data ?? []) if (r.evaluation?.grade) counts.set(r.evaluation.grade, (counts.get(r.evaluation.grade) ?? 0) + 1);
    const gradeRows = GRADES.filter((g) => counts.get(g));
    body = (
      <div className="flex flex-col gap-6">
        {cycle.status === "archived" && <Alert variant="info">This cycle is archived. Evaluations are closed; records are read-only.</Alert>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard title="Pending evaluations" query={pending} to="/supervisor/submissions" linkLabel="Open evaluation queue" />
          <StatCard title="Rework requested" query={rework} to="/supervisor/submissions?status=rework_requested" linkLabel="View rework" />
          <StatCard title="Allocated trainees" query={allocated} to="/supervisor/progress" linkLabel="View progress" />
          <StatCard title="Late submissions" query={late} to="/supervisor/progress?late_only=true" linkLabel="View late" />
        </div>
        <section className="rounded-lg border border-border bg-surface p-4">
          <h2 className="mb-2 text-base font-semibold">Grade distribution</h2>
          {grades.isLoading ? <LoadingState /> : grades.error ? (
            <ErrorState error={grades.error} onRetry={() => void grades.refetch()} />
          ) : gradeRows.length ? (
            <ul className="flex flex-col gap-1.5 text-sm">
              {gradeRows.map((g) => (
                <li key={g} className="flex items-center justify-between gap-2"><StatusBadge kind="grade" value={g} /><span className="tabular-nums">{counts.get(g)}</span></li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted">No evaluations yet.</p>}
        </section>
        <div>
          <h2 className="mb-3 text-base font-semibold">My projects</h2>
          <ProjectsSection />
        </div>
      </div>
    );
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={cycle ? <span className="inline-flex flex-wrap items-center gap-2">{cycle.name} <StatusBadge kind="cycle" value={cycle.status} /></span> : undefined}
      />
      {body}
    </>
  );
}
