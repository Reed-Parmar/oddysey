/** /admin overview (RPT-01; admin.md §3.1). Numbers come from RPT-01; only coverage %, capacity % and zero-filled grades are derived. */
import {
  ArrowRight, ChalkboardTeacher, ChartBar, CheckCircle, ClipboardText, EnvelopeSimple, FolderSimple, Gauge,
  GraduationCap, ListChecks, Plus, ShieldCheck, Sparkle, Student, Target, UserMinus, UsersThree,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Overview } from "@/api/types";
import {
  DataTable, DateTime, EmptyState, ErrorState, LoadingState, Meter, PageHeader, ScoreBar, StackedBar, StatCard,
  StatusBadge, Steps, type Column,
} from "@/components/shared";
import { Card, cx } from "@/components/ui";

import { CapacityBar, CycleSelect, LinkButton, MetaLine, StatTile, TextLink, useScopedCycle } from "./common";

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
  const projectTotal = projects.data?.meta.total ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" eyebrow="Programme team"
        description={cycle ? (
          <MetaLine items={[
            <TextLink key="n" to={`/admin/cycles/${cycle.id}`}>{cycle.name}</TextLink>,
            <StatusBadge key="s" kind="cycle" value={cycle.status} />,
          ]} />
        ) : "No active cycle"}
        actions={scope.cycles.length > 1 || (!scope.active && scope.cycles.length) ? (
          <div className="w-64 max-w-full"><CycleSelect id="overview-cycle" value={scope.id} onChange={setCycleSel} cycles={scope.cycles} activeId={scope.active?.id} /></div>
        ) : undefined} />

      {!cycle && (scope.cycles.length === 0 ? (
        <EmptyState icon={<Target />} title="Create your first cycle" description="A cycle holds the trainees, projects, recommendations and allocations for one programme round."
          action={<LinkButton variant="primary" icon={<Plus />} to="/admin/cycles?create=1">Create cycle</LinkButton>} />
      ) : (
        <EmptyState icon={<Target />} title="No active cycle" description="Create a new cycle, or pick an archived one above to view its results."
          action={<LinkButton icon={<Plus />} to="/admin/cycles?create=1">Create a new cycle</LinkButton>} />
      ))}

      {cycle && <KpiRow o={o} projectTotal={projectTotal} />}

      {cycle && cycle.status !== "archived" && <NextSteps steps={buildSteps(o, projectTotal)} />}

      {cycle && <CycleSections o={o} />}

      <UsersCard o={o} />
    </div>
  );
}

function KpiRow({ o, projectTotal }: { o: Overview; projectTotal: number }) {
  const t = o.trainees;
  const a = o.allocation;
  const s = o.submissions;
  const published = o.demand?.length ?? 0;
  const received = s ? s.submitted + s.rework_requested + s.evaluated : 0;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label="Trainees" value={t?.total ?? 0} icon={<GraduationCap />} to="/admin/trainees"
        hint={t ? `${t.assessment_complete} assessed · ${t.assessment_pending} pending` : undefined} />
      <StatCard label="Published projects" value={published} icon={<FolderSimple />} tone="accent" to="/admin/projects"
        hint={`${projectTotal} in catalogue${a ? ` · ${a.capacity_total} seats` : ""}`} />
      <StatCard label="Allocated" value={a?.allocated ?? 0} icon={<Target />} tone="success" to="/admin/allocations"
        hint={a ? `Coverage ${pct(a.allocated, a.allocated + a.unallocated)} · ${a.unallocated} unallocated` : undefined} />
      <StatCard label="Evaluated" value={s?.evaluated ?? 0} icon={<CheckCircle />} tone="primary" to="/admin/progress"
        hint={s ? `${received} submitted · ${s.submitted} awaiting` : undefined} />
    </div>
  );
}

function NextSteps({ steps }: { steps: Step[] }) {
  const next = steps.findIndex((s) => !s.done);
  const doneCount = steps.filter((s) => s.done).length;
  const nextStep = next >= 0 ? steps[next] : null;
  return (
    <Card title="Next steps" icon={<ListChecks />} description={`${doneCount} of ${steps.length} setup steps done`}>
      {nextStep && (
        <div className="mb-5 flex flex-col gap-3 rounded-lg border border-primary/25 bg-primary-soft px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold tracking-wide text-primary-ink uppercase">Up next</p>
            <p className="font-heading text-base font-semibold text-text">{nextStep.label}</p>
            <p className="text-sm text-muted">{nextStep.hint}</p>
          </div>
          <LinkButton variant="primary" to={nextStep.to} icon={<ArrowRight />} className="self-start sm:self-auto">Start</LinkButton>
        </div>
      )}
      <Steps steps={steps.map((s, i) => ({
        label: s.label,
        state: s.done ? "done" : i === next ? "current" : "todo",
        hint: (
          <span className="flex flex-col gap-0.5">
            <span>{s.hint}</span>
            {i !== next && (
              <Link className="w-fit font-semibold text-primary hover:underline" to={s.to}>
                {s.done ? "Review" : "Open"}<span className="sr-only">: {s.label}</span>
              </Link>
            )}
          </span>
        ),
      }))} />
    </Card>
  );
}

function CardLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 rounded text-sm font-semibold text-primary hover:underline">
      {children}<ArrowRight aria-hidden size={14} />
    </Link>
  );
}

function UsersCard({ o }: { o: Overview }) {
  const u = o.users;
  const items: { label: string; value: number; icon: ReactNode }[] = [
    { label: "Students", value: u.students, icon: <Student /> },
    { label: "Supervisors", value: u.supervisors, icon: <ChalkboardTeacher /> },
    { label: "Admins", value: u.admins, icon: <ShieldCheck /> },
    { label: "Disabled", value: u.disabled, icon: <UserMinus /> },
    { label: "Pending invitations", value: u.pending_invitations, icon: <EnvelopeSimple /> },
  ];
  return (
    <Card title="Users" icon={<UsersThree />} description="Accounts across all cycles" actions={<CardLink to="/admin/users">Manage</CardLink>}>
      <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {items.map((it) => (
          <li key={it.label} className="flex min-w-0 items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
            <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface text-muted shadow-card [&>svg]:size-[18px]">{it.icon}</span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium text-muted">{it.label}</span>
              <span className="block font-heading text-lg font-semibold text-text tabular-nums">{it.value}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function CycleSections({ o }: { o: Overview }) {
  const t = o.trainees;
  const r = o.recommendations;
  const a = o.allocation;
  const s = o.submissions;
  const grades = o.grades ?? {};
  const gradeTotal = GRADE_ORDER.reduce((n, g) => n + (grades[g] ?? 0), 0);
  const gradeMax = Math.max(0, ...GRADE_ORDER.map((g) => grades[g] ?? 0));
  const demandCols: Column<NonNullable<Overview["demand"]>[number]>[] = [
    { key: "code", header: "Code", className: "whitespace-nowrap", cell: (d) => <TextLink to={`/admin/projects/${d.project_id}`}>{d.project_code}</TextLink> },
    { key: "title", header: "Title", className: "min-w-48", cell: (d) => d.title },
    { key: "elig", header: "Eligible", className: "text-right tabular-nums", cell: (d) => d.eligible_trainees },
    { key: "cap", header: "Capacity", className: "text-right tabular-nums", cell: (d) => d.max_trainees },
    { key: "alloc", header: "Allocated", className: "text-right tabular-nums", cell: (d) => d.allocated },
    { key: "fill", header: <span className="sr-only">Capacity filled</span>, cell: (d) => <CapacityBar value={d.allocated} max={d.max_trainees} label={`${d.project_code} capacity filled`} /> },
  ];
  return (
    <>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {a && (
          <Card title="Allocation" icon={<Target />} actions={<CardLink to="/admin/allocations">Review allocations</CardLink>}>
            <div className="flex flex-col gap-5">
              <StackedBar label="Trainee coverage" segments={[
                { label: "Allocated", value: a.allocated, className: "bg-success" },
                { label: "Unallocated", value: a.unallocated, className: "bg-subtle" },
              ]} />
              <Meter label="Capacity used" value={a.capacity_used} max={a.capacity_total}
                valueLabel={`${a.capacity_used} / ${a.capacity_total} · ${pct(a.capacity_used, a.capacity_total)}`} />
              <div className="grid grid-cols-3 gap-3">
                <StatTile label="Auto" value={a.auto} />
                <StatTile label="Manual" value={a.manual} />
                <StatTile label="Overrides" value={a.overrides} tone={a.overrides ? "warning" : undefined} />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4 text-sm">
                <span className="font-medium text-muted">Average match score</span>
                {a.average_match_score == null ? <span>—</span> : <ScoreBar value={a.average_match_score} label="Average match score" tone="auto" />}
              </div>
            </div>
          </Card>
        )}
        {r && (
          <Card title="Recommendations" icon={<Sparkle />} actions={<CardLink to="/admin/recommendations">Run recommendations</CardLink>}>
            {!r.latest_run ? (
              <p className="text-sm text-muted">No recommendations yet. <TextLink to="/admin/recommendations">Run recommendations</TextLink></p>
            ) : (
              <div className="flex flex-col gap-5">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge kind="run" value={r.latest_run.status} />
                  {r.latest_run.finished_at && <span className="text-muted">Finished <DateTime value={r.latest_run.finished_at} /></span>}
                </div>
                <StackedBar label="Trainees by eligibility" segments={[
                  { label: "With an eligible project", value: r.trainees_with_eligible, className: "bg-primary" },
                  { label: "Without an eligible project", value: r.trainees_without_eligible, className: "bg-warning" },
                ]} />
                <div className="grid grid-cols-2 gap-3">
                  <StatTile label="AI used" value={r.latest_run.ai_used_count} tone="info" />
                  <StatTile label="AI failed" value={r.latest_run.ai_failed_count} tone={r.latest_run.ai_failed_count ? "danger" : undefined} />
                </div>
              </div>
            )}
          </Card>
        )}
      </div>

      {o.demand && (
        <Card flush title="Demand by published project" icon={<Gauge />}
          description="Eligible trainees in the latest run against each project's capacity"
          actions={<CardLink to="/admin/projects">All projects</CardLink>}>
          {o.demand.length === 0 ? (
            <p className="px-5 pb-5 text-sm text-muted">No published projects yet. <TextLink to="/admin/projects">Publish projects</TextLink></p>
          ) : (
            <div className="border-t border-border [&>.overflow-x-auto]:rounded-none [&>.overflow-x-auto]:border-0 [&>.overflow-x-auto]:shadow-none">
              <DataTable rows={o.demand} columns={demandCols} rowKey={(d) => d.project_id} caption="Demand per project" />
            </div>
          )}
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {s && (
          <Card title="Submissions" icon={<ClipboardText />} actions={<CardLink to="/admin/progress">View progress</CardLink>}>
            <div className="flex flex-col gap-5">
              <StackedBar label="Submission status" segments={[
                { label: "Not submitted", value: s.not_submitted, className: "bg-subtle" },
                { label: "Awaiting evaluation", value: s.submitted, className: "bg-info" },
                { label: "Rework requested", value: s.rework_requested, className: "bg-warning" },
                { label: "Evaluated", value: s.evaluated, className: "bg-success" },
              ]} />
              <Meter label="Evaluation progress" tone="success" value={s.evaluated}
                max={s.not_submitted + s.submitted + s.rework_requested + s.evaluated} />
              <div className={cx("flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm",
                s.late ? "border-warning/30 bg-warning-bg text-warning" : "border-border bg-surface-2 text-muted")}>
                <span className="font-medium">Late</span>
                <span className="font-semibold tabular-nums">{s.late}</span>
              </div>
            </div>
          </Card>
        )}
        {o.grades && (
          <Card title="Grade distribution" icon={<ChartBar />} description={`${gradeTotal} graded`}>
            <ul className="flex flex-col gap-3">
              {GRADE_ORDER.map((g) => {
                const n = grades[g] ?? 0;
                return (
                  <li key={g} className="grid grid-cols-[11rem_1fr_2rem] items-center gap-3 text-sm">
                    <span className="min-w-0"><StatusBadge kind="grade" value={g} /></span>
                    <span aria-hidden className="h-2 overflow-hidden rounded-full bg-neutral-bg">
                      <span className="block h-full rounded-full bg-chart-1" style={{ width: `${gradeMax ? (n / gradeMax) * 100 : 0}%` }} />
                    </span>
                    <span className="text-right font-semibold tabular-nums">{n}</span>
                  </li>
                );
              })}
            </ul>
          </Card>
        )}
      </div>

      {t && (
        <Card title="Trainees" icon={<GraduationCap />} actions={<CardLink to="/admin/trainees">View trainees</CardLink>}>
          <div className="grid gap-6 md:grid-cols-2">
            <div className="flex flex-col gap-5">
              <StackedBar label="Assessment status" segments={[
                { label: "Assessed", value: t.assessment_complete, className: "bg-success" },
                { label: "Assessment pending", value: t.assessment_pending, className: "bg-warning" },
              ]} />
              <Meter label="Linked accounts" value={t.linked_accounts} max={t.total} />
            </div>
            {t.by_trade.length > 0 && (
              <div className="min-w-0">
                <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">By trade</p>
                <ul className="flex flex-col divide-y divide-border" aria-label="Trainees by trade">
                  {t.by_trade.map((b) => (
                    <li key={b.trade_id} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                      <span className="min-w-0 truncate text-text">{b.name}</span>
                      <span className="font-semibold tabular-nums">{b.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>
      )}
    </>
  );
}
