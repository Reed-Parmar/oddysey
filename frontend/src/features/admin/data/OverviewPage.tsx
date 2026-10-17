/** /admin overview (RPT-01; admin.md §3.1). Numbers come from RPT-01; only coverage %, capacity % and zero-filled grades are derived. */
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Overview } from "@/api/types";
import {
  DataTable, DateTime, EmptyState, ErrorState, LoadingState, PageHeader, ScoreBar, StatusBadge, type Column,
} from "@/components/shared";
import { Card } from "@/components/ui";

import { CycleSelect, StatTile, useScopedCycle } from "./common";

const GRADE_ORDER = ["A1", "A", "B+", "B", "C", "D"] as const;
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");

export type Step = { key: string; label: string; done: boolean; to: string; hint: string };

/** Next-step checklist derived from RPT-01 (+ project count). The first not-done step is "next". */
export function buildSteps(o: Overview, projectTotal: number): Step[] {
  const c = o.cycle;
  const published = (o.demand?.length ?? 0) > 0;
  return [
    { key: "cycle", label: "Create a cycle", done: !!c, to: "/admin/cycles?create=1", hint: "Name and submission deadline" },
    { key: "trainees", label: "Import trainees", done: (o.trainees?.total ?? 0) > 0, to: "/admin/trainees", hint: "Trainee Profiles sheet" },
    { key: "projects", label: "Import projects", done: projectTotal > 0, to: "/admin/projects", hint: "Project Catalog sheet" },
    { key: "publish-projects", label: "Assign supervisors and publish projects", done: published, to: "/admin/projects", hint: "Only published projects are scored" },
    { key: "recs", label: "Run recommendations", done: o.recommendations?.latest_run?.status === "completed", to: "/admin/recommendations", hint: "Rule scoring with optional AI refinement" },
    { key: "alloc", label: "Auto-allocate and review", done: (o.allocation?.allocated ?? 0) > 0, to: "/admin/allocations", hint: "Draft allocations you can edit" },
    { key: "publish", label: "Publish allocations", done: c?.status === "published" || c?.status === "archived", to: c ? `/admin/cycles/${c.id}` : "/admin/cycles", hint: "Students and supervisors see them" },
  ];
}

export function AdminOverview() {
  const [cycleSel, setCycleSel] = useState("");
  const scope = useScopedCycle(cycleSel);
  const report = useQuery({
    queryKey: qk.reports.overview(scope.id || undefined),
    queryFn: () => call(api.GET("/api/v1/admin/reports/overview", { params: { query: scope.id ? { cycle_id: scope.id } : {} } })),
    enabled: !scope.isLoading,
  });
  const projParams = { cycle_id: scope.id, page_size: 1 };
  const projects = useQuery({
    queryKey: qk.projects.list(projParams),
    queryFn: () => call(api.GET("/api/v1/projects", { params: { query: projParams } })),
    enabled: !!scope.id,
  });

  if (scope.isLoading || report.isPending) return <LoadingState />;
  if (scope.error) return <ErrorState error={scope.error} />;
  if (report.error || !report.data) return <ErrorState error={report.error} onRetry={() => report.refetch()} />;
  const o = report.data.data;
  const cycle = o.cycle;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Overview"
        description={cycle ? <span className="inline-flex flex-wrap items-center gap-2"><Link className="text-primary underline" to={`/admin/cycles/${cycle.id}`}>{cycle.name}</Link><StatusBadge kind="cycle" value={cycle.status} /></span> : "No active cycle"}
        actions={scope.cycles.length > 1 || (!scope.active && scope.cycles.length) ? (
          <div className="w-64 max-w-full"><CycleSelect id="overview-cycle" value={scope.id} onChange={setCycleSel} cycles={scope.cycles} activeId={scope.active?.id} /></div>
        ) : undefined} />

      {!cycle && (scope.cycles.length === 0 ? (
        <EmptyState title="Create your first cycle" description="A cycle holds the trainees, projects, recommendations and allocations for one programme round."
          action={<Link className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-fg" to="/admin/cycles?create=1">Create cycle</Link>} />
      ) : (
        <EmptyState title="No active cycle" description="Create a new cycle, or pick an archived one above to view its results."
          action={<Link className="text-primary underline" to="/admin/cycles?create=1">Create a new cycle</Link>} />
      ))}

      {cycle && cycle.status !== "archived" && <NextSteps steps={buildSteps(o, projects.data?.meta.total ?? 0)} />}

      <Card title="Users">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile label="Students" value={o.users.students} />
          <StatTile label="Supervisors" value={o.users.supervisors} />
          <StatTile label="Admins" value={o.users.admins} />
          <StatTile label="Disabled" value={o.users.disabled} />
          <StatTile label="Pending invitations" value={o.users.pending_invitations} hint={<Link className="text-primary underline" to="/admin/users">Manage</Link>} />
        </div>
      </Card>

      {cycle && <CycleSections o={o} />}
    </div>
  );
}

function NextSteps({ steps }: { steps: Step[] }) {
  const next = steps.findIndex((s) => !s.done);
  return (
    <Card title="Next steps">
      <ol className="flex flex-col gap-2">
        {steps.map((s, i) => (
          <li key={s.key} className={`flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${i === next ? "border-primary/50 bg-primary/5" : "border-border"}`}>
            <span className="flex items-center gap-2">
              <span aria-hidden className={`flex size-6 items-center justify-center rounded-full text-xs ${s.done ? "bg-success-bg text-success" : "bg-neutral-bg text-muted"}`}>{s.done ? "✓" : i + 1}</span>
              <span>
                <span className={s.done ? "text-muted" : "font-medium"}>{s.label}</span>
                <span className="sr-only">{s.done ? " (done)" : i === next ? " (next)" : ""}</span>
                <span className="block text-xs text-muted">{s.hint}</span>
              </span>
            </span>
            <Link className={i === next ? "rounded-md bg-primary px-3 py-1.5 text-primary-fg" : "text-primary underline"} to={s.to}>
              {s.done ? "Review" : i === next ? "Start" : "Open"}
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}

function CycleSections({ o }: { o: Overview }) {
  const t = o.trainees;
  const r = o.recommendations;
  const a = o.allocation;
  const s = o.submissions;
  const grades = o.grades ?? {};
  const demandCols: Column<NonNullable<Overview["demand"]>[number]>[] = [
    { key: "code", header: "Code", cell: (d) => <Link className="text-primary underline" to={`/admin/projects/${d.project_id}`}>{d.project_code}</Link> },
    { key: "title", header: "Title", cell: (d) => d.title },
    { key: "cap", header: "Capacity", className: "text-right tabular-nums", cell: (d) => d.max_trainees },
    { key: "elig", header: "Eligible", className: "text-right tabular-nums", cell: (d) => d.eligible_trainees },
    { key: "alloc", header: "Allocated", className: "text-right tabular-nums", cell: (d) => d.allocated },
  ];
  return (
    <>
      {t && (
        <Card title="Trainees" actions={<Link className="text-sm text-primary underline" to="/admin/trainees">View trainees</Link>}>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatTile label="Total" value={t.total} />
            <StatTile label="Assessed" value={t.assessment_complete} />
            <StatTile label="Assessment pending" value={t.assessment_pending} />
            <StatTile label="Linked accounts" value={t.linked_accounts} />
          </div>
          {t.by_trade.length > 0 && (
            <ul className="mt-3 flex flex-wrap gap-2 text-sm" aria-label="Trainees by trade">
              {t.by_trade.map((b) => <li key={b.trade_id} className="rounded-full border border-border bg-neutral-bg px-3 py-1">{b.name}: <span className="font-semibold tabular-nums">{b.count}</span></li>)}
            </ul>
          )}
        </Card>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {r && (
          <Card title="Recommendations" actions={<Link className="text-sm text-primary underline" to="/admin/recommendations">Run recommendations</Link>}>
            {!r.latest_run ? (
              <p className="text-sm text-muted">No recommendations yet. <Link className="text-primary underline" to="/admin/recommendations">Run recommendations</Link></p>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge kind="run" value={r.latest_run.status} />
                  {r.latest_run.finished_at && <span className="text-muted">Finished <DateTime value={r.latest_run.finished_at} /></span>}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <StatTile label="AI used" value={r.latest_run.ai_used_count} />
                  <StatTile label="AI failed" value={r.latest_run.ai_failed_count} />
                  <StatTile label="With an eligible project" value={r.trainees_with_eligible} />
                  <StatTile label="Without an eligible project" value={r.trainees_without_eligible} />
                </div>
              </div>
            )}
          </Card>
        )}
        {a && (
          <Card title="Allocation" actions={<Link className="text-sm text-primary underline" to="/admin/allocations">Review allocations</Link>}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatTile label="Allocated" value={a.allocated} hint={`Coverage ${pct(a.allocated, a.allocated + a.unallocated)}`} />
              <StatTile label="Unallocated" value={a.unallocated} />
              <StatTile label="Capacity used" value={`${a.capacity_used} / ${a.capacity_total}`} hint={pct(a.capacity_used, a.capacity_total)} />
              <StatTile label="Auto" value={a.auto} />
              <StatTile label="Manual" value={a.manual} />
              <StatTile label="Overrides" value={a.overrides} />
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">Average match score</span>
              {a.average_match_score == null ? <span>—</span> : <ScoreBar value={a.average_match_score} label="Average match score" />}
            </div>
          </Card>
        )}
      </div>
      {o.demand && (
        <Card title="Demand by published project">
          {o.demand.length === 0 ? <p className="text-sm text-muted">No published projects yet. <Link className="text-primary underline" to="/admin/projects">Publish projects</Link></p> : (
            <DataTable rows={o.demand} columns={demandCols} rowKey={(d) => d.project_id} caption="Demand per project" />
          )}
        </Card>
      )}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {s && (
          <Card title="Submissions" actions={<Link className="text-sm text-primary underline" to="/admin/progress">View progress</Link>}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatTile label="Not submitted" value={s.not_submitted} />
              <StatTile label="Awaiting evaluation" value={s.submitted} />
              <StatTile label="Rework requested" value={s.rework_requested} />
              <StatTile label="Evaluated" value={s.evaluated} />
              <StatTile label="Late" value={s.late} />
            </div>
          </Card>
        )}
        {o.grades && (
          <Card title="Grade distribution">
            <ul className="flex flex-col gap-2">
              {GRADE_ORDER.map((g) => (
                <li key={g} className="flex items-center justify-between gap-2 text-sm">
                  <StatusBadge kind="grade" value={g} />
                  <span className="font-semibold tabular-nums">{grades[g] ?? 0}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </>
  );
}
