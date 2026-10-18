/** /admin/tracking: allocation & progress for every trainee in a cycle (TrackingEnvelope; ADR-017). */
import { ChartBar, ClockCountdown, GraduationCap, Target, UsersThree, Warning } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { ProgressRow, TrackingSummary } from "@/api/types";
import {
  Avatar, DataTable, EmptyState, ErrorState, LoadingState, Meter, PageHeader, Pagination, StackedBar, StatCard, StatusBadge,
  type Column,
} from "@/components/shared";
import { Card } from "@/components/ui";
import { formatScore } from "@/lib/format";
import { label } from "@/lib/statusLabels";

import {
  CardState, CycleSelect, FilterBar, LabeledSelect, LinkButton, ReadOnlyBanner, SearchInput, TableCard, formatIst, triggerLabel,
  useDebounced, useScopedCycle, useTrades,
} from "../data/common";
import { TraineeDrawer } from "./TraineeDrawer";

const PROGRESS = ["unallocated", "allocated", "submitted", "rework_requested", "evaluated"] as const;
const ANALYSIS = ["queued", "extracting", "analysing", "completed", "retrying", "failed", "insufficient_evidence", "review_required", "not_analyzable"] as const;
const GRADE_ORDER = ["A1", "A", "B+", "B", "C", "D"] as const;
const PROGRESS_TONE: Record<string, string> = {
  unallocated: "bg-subtle", allocated: "bg-info", submitted: "bg-chart-2", rework_requested: "bg-warning", evaluated: "bg-success",
};
const dash = <span className="text-muted">—</span>;

export function TrackingPage() {
  const [params, setParams] = useSearchParams();
  const scope = useScopedCycle(params.get("cycle") ?? "");
  const trades = useTrades();
  const [q, setQ] = useState("");
  const [progress, setProgress] = useState("");
  const [analysis, setAnalysis] = useState("");
  const [trade, setTrade] = useState("");
  const [project, setProject] = useState("");
  const [lateOnly, setLateOnly] = useState(false);
  const [sort, setSort] = useState("trainee_name");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ProgressRow | null>(null);
  const dq = useDebounced(q.trim());

  const projectParams = { cycle_id: scope.id || undefined, sort: "title", page_size: 100 };
  const projects = useQuery({
    queryKey: qk.projects.list(projectParams),
    queryFn: () => call(api.GET("/api/v1/projects", { params: { query: projectParams } })),
    enabled: scope.ready,
  });

  const query = {
    cycle_id: scope.id || undefined, include_unallocated: true, page, page_size: 25, q: dq || undefined,
    progress: (progress || undefined) as ProgressRow["progress"] | undefined,
    analysis_status: (analysis || undefined) as (typeof ANALYSIS)[number] | undefined,
    trade_id: trade || undefined, project_id: project || undefined, late_only: lateOnly || undefined, sort,
  };
  const list = useQuery({
    queryKey: qk.progress.list(query),
    queryFn: () => call(api.GET("/api/v1/progress", { params: { query } })),
    enabled: scope.ready,
    placeholderData: keepPreviousData,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const filtered = !!(dq || progress || analysis || trade || project || lateOnly);
  const archived = scope.cycle?.status === "archived";

  const cols: Column<ProgressRow>[] = [
    { key: "trainee", header: "Trainee", sort: "trainee_name", cell: (r) => (
      <span className="flex min-w-44 items-center gap-2.5">
        <Avatar name={r.trainee.full_name} size="sm" />
        <span className="min-w-0">
          <button type="button" className="block text-left font-semibold text-primary hover:underline"
            onClick={(e) => { e.stopPropagation(); setSelected(r); }}>
            {r.trainee.full_name}<span className="sr-only"> (open details)</span>
          </button>
          <span className="block text-xs text-muted tabular-nums">{r.trainee.trainee_code}</span>
        </span>
      </span>
    ) },
    ...(scope.multi ? [{ key: "cycle", header: "Cycle", cell: (r: ProgressRow) => <span className="whitespace-nowrap">{r.cycle.name}</span> }] : []),
    { key: "trades", header: "Trades", cell: (r) => <span className="block min-w-28">{r.trainee.trades.map((t) => t.name).join(", ") || "—"}</span> },
    { key: "project", header: "Current project", sort: "project_title", cell: (r) => r.project ? (
      <span className="block min-w-44">{r.project.title}<span className="block text-xs text-muted">{r.project.project_code}</span></span>
    ) : r.waiting_reason ? <StatusBadge kind="waiting" value={r.waiting_reason} /> : dash },
    { key: "sup", header: "Supervisor", cell: (r) => r.supervisor ? <span className="whitespace-nowrap">{r.supervisor.full_name}</span> : dash },
    { key: "min", header: "Minimum match", className: "tabular-nums", cell: (r) => r.allocation ? (r.allocation.min_match_score > 0 ? `${formatScore(r.allocation.min_match_score)} / 100` : "None") : dash },
    { key: "match", header: "Trainee match", sort: "-match_score", cell: (r) => r.allocation ? (
      <span className="flex flex-col whitespace-nowrap">
        <span className="font-semibold tabular-nums">{formatScore(r.allocation.match_score)} / 100</span>
        {r.allocation.match_mode && <span className="text-xs text-muted">{label("matchMode", r.allocation.match_mode)[0]}</span>}
      </span>
    ) : dash },
    { key: "source", header: "Source", cell: (r) => r.allocation ? (
      <span className="flex flex-col whitespace-nowrap">
        <span>{triggerLabel(r.allocation.trigger)}</span>
        <span className="text-xs text-muted">{label("allocationSource", r.allocation.source)[0]}</span>
      </span>
    ) : dash },
    { key: "status", header: "Status", cell: (r) => (
      <span className="flex flex-wrap gap-1">
        <StatusBadge kind="progress" value={r.progress} />
        {r.latest_submission?.is_late && <StatusBadge kind="late" value="late" />}
        {r.rejections > 0 && <span className="text-xs text-muted">{r.rejections} rejected</span>}
      </span>
    ) },
    { key: "version", header: "Latest submission", cell: (r) => r.latest_submission ? (
      <span className="flex flex-col items-start gap-1 whitespace-nowrap">
        <Link to={`/admin/submissions/${r.latest_submission.id}`} onClick={(e) => e.stopPropagation()}
          className="font-semibold text-primary tabular-nums hover:underline">
          Version {r.latest_submission.version}<span className="sr-only"> of {r.trainee.full_name}'s submission (open)</span>
        </Link>
        <span className="text-xs text-muted">{formatIst(r.latest_submission.submitted_at)}</span>
        <span className="flex flex-wrap gap-1">
          <StatusBadge kind="submission" value={r.latest_submission.status} />
          {r.analysis_status && <StatusBadge kind="analysis" value={r.analysis_status} />}
        </span>
      </span>
    ) : dash },
    { key: "score", header: "Latest evaluation", sort: "-total_score", cell: (r) => r.evaluation && r.evaluation.total_score != null ? (
      <span className="flex flex-col whitespace-nowrap">
        <span className="font-semibold tabular-nums">{formatScore(r.evaluation.total_score)} / {r.evaluation.max_score}</span>
        <span className="text-xs text-muted">{label("scoreType", r.evaluation.score_type)[0]}</span>
      </span>
    ) : dash },
    { key: "grade", header: "Grade", cell: (r) => r.evaluation?.grade ? <StatusBadge kind="grade" value={r.evaluation.grade} /> : dash },
    { key: "deadline", header: "Project deadline", sort: "deadline", cell: (r) => r.deadline ? <span className="whitespace-nowrap">{formatIst(r.deadline)}</span> : dash },
    { key: "archive", header: "Archive state", cell: (r) => r.archived ? <StatusBadge kind="cycle" value="archived" /> : <span className="text-muted">Open</span> },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Allocation & Progress" eyebrow="Programme team"
        description="Every trainee in the active cycles (or the cycle you pick): their automatically allocated project, match details, submissions and evaluation. Select a trainee for full details."
        actions={<LinkButton variant="primary" to={scope.id ? `/admin/trainees?cycle=${encodeURIComponent(scope.id)}` : "/admin/trainees"}>Upload or manage trainees</LinkButton>} />
      {archived && <ReadOnlyBanner />}
      {scope.isLoading ? <LoadingState /> : scope.error ? <ErrorState error={scope.error} /> : !scope.ready ? (
        <EmptyState icon={<Target />} title="No active cycle" description="Create a cycle on the Overview page first."
          action={<LinkButton variant="primary" to="/admin">Go to Overview</LinkButton>} />
      ) : (
        <>
          {list.data ? <SummaryPanel s={list.data.summary} filtered={filtered} /> : list.isLoading ? <LoadingState /> : null}
          <TableCard
            title="Trainees" icon={<UsersThree />}
            description="One row per trainee. Each trainee works on their project individually. Open a submission version to review it."
            toolbar={<div className="flex flex-col gap-3">
              <FilterBar>
                <CycleSelect id="trk-cycle" value={scope.id} cycles={scope.cycles} actives={scope.actives}
                  onChange={(v) => { setParams(v ? { cycle: v } : {}); setProject(""); setPage(1); }} />
                <SearchInput id="trk-q" label="Search" value={q} onChange={reset(setQ)} placeholder="Trainee, ID, project or code" />
                <LabeledSelect id="trk-progress" label="Status" value={progress} onChange={reset(setProgress)}>
                  <option value="">Any</option>
                  {PROGRESS.map((p) => <option key={p} value={p}>{label("progress", p)[0]}</option>)}
                </LabeledSelect>
                <LabeledSelect id="trk-analysis" label="Analysis" value={analysis} onChange={reset(setAnalysis)}>
                  <option value="">Any</option>
                  {ANALYSIS.map((a) => <option key={a} value={a}>{label("analysis", a)[0]}</option>)}
                </LabeledSelect>
                <LabeledSelect id="trk-trade" label="Trade" value={trade} onChange={reset(setTrade)}>
                  <option value="">All trades</option>
                  {(trades.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </LabeledSelect>
                <LabeledSelect id="trk-project" label="Project" value={project} onChange={reset(setProject)}>
                  <option value="">All projects</option>
                  {(projects.data?.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.project_code} · {p.title}</option>)}
                </LabeledSelect>
                <LabeledSelect id="trk-sort" label="Sort" value={sort} onChange={reset(setSort)}>
                  <option value="trainee_name">Trainee name</option>
                  <option value="project_title">Project</option>
                  <option value="-match_score">Highest match first</option>
                  <option value="-total_score">Highest score first</option>
                  <option value="deadline">Deadline</option>
                </LabeledSelect>
                <label className="inline-flex min-h-11 items-center gap-2 self-end text-sm font-medium">
                  <input type="checkbox" className="size-4 accent-primary" checked={lateOnly} onChange={(e) => { setLateOnly(e.target.checked); setPage(1); }} />
                  Late submissions only
                </label>
              </FilterBar>
            </div>}
            footer={list.data?.data.length ? <Pagination meta={list.data.meta} onPageChange={setPage} /> : undefined}>
            {list.isLoading ? <CardState><LoadingState /></CardState> : list.error ? <CardState><ErrorState error={list.error} onRetry={() => void list.refetch()} /></CardState> :
              !list.data?.data.length ? (
                <CardState>
                  <EmptyState icon={<GraduationCap />} title={filtered ? "No trainees match these filters" : "No trainees in this cycle yet"}
                    description={filtered ? undefined : "Trainees appear here once they register and complete onboarding, or are imported."} />
                </CardState>
              ) : (
                <DataTable rows={list.data.data} columns={cols} rowKey={(r) => r.trainee.id} sort={sort} onSortChange={reset(setSort)}
                  onRowClick={setSelected} caption="Allocation and progress by trainee" />
              )}
          </TableCard>
        </>
      )}
      <TraineeDrawer row={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function SummaryPanel({ s, filtered }: { s: TrackingSummary; filtered: boolean }) {
  const waiting = Object.entries(s.by_waiting_reason).filter(([, n]) => n > 0);
  const analysis = Object.entries(s.by_analysis).filter(([, n]) => n > 0);
  const graded = GRADE_ORDER.some((g) => (s.by_grade[g] ?? 0) > 0);
  return (
    <section aria-label="Summary" className="space-y-4">
      {filtered && <p className="text-sm text-muted">Summary of the trainees matching the current filters.</p>}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Trainees" value={s.total} icon={<UsersThree />} hint={`${s.assigned} assigned · ${s.unassigned} waiting`} />
        <StatCard label="Due within 7 days" value={s.due_within_7_days} icon={<ClockCountdown />} tone="warning" />
        <StatCard label="Late submissions" value={s.late} icon={<Warning />} tone={s.late ? "danger" : "neutral"} />
        <StatCard label="Rejections" value={s.rejections} icon={<Target />} tone="neutral" hint="Trainees who declined a project" />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Coverage and progress" icon={<ChartBar />}>
          <div className="flex flex-col gap-4">
            <Meter label="Trainees assigned a project" value={s.assigned} max={s.total} tone="success"
              valueLabel={`${s.assigned} / ${s.total}${s.total ? ` (${Math.round((s.assigned / s.total) * 100)}%)` : ""}`} />
            <StackedBar label="Trainees by status"
              segments={PROGRESS.map((p) => ({ label: label("progress", p)[0], value: s.by_progress[p] ?? 0, className: PROGRESS_TONE[p] }))} />
          </div>
        </Card>
        <Card title="Evaluation and waiting" icon={<GraduationCap />}>
          <div className="flex flex-col gap-4 text-sm">
            <div>
              <h3 className="mb-2 font-semibold">Grades</h3>
              {graded ? <StackedBar label="Grade distribution" segments={GRADE_ORDER.map((g) => ({ label: g, value: s.by_grade[g] ?? 0 }))} />
                : <p className="text-muted">No grades yet.</p>}
            </div>
            <div>
              <h3 className="mb-1.5 font-semibold">Report analysis</h3>
              {analysis.length ? (
                <ul className="flex flex-wrap gap-1.5">{analysis.map(([k, n]) => (
                  <li key={k} className="inline-flex items-center gap-1.5"><StatusBadge kind="analysis" value={k} /><span className="font-semibold tabular-nums">{n}</span></li>
                ))}</ul>
              ) : <p className="text-muted">No submissions analysed yet.</p>}
            </div>
            <div>
              <h3 className="mb-1.5 font-semibold">Why trainees are waiting</h3>
              {waiting.length ? (
                <ul className="flex flex-wrap gap-1.5">{waiting.map(([k, n]) => (
                  <li key={k} className="inline-flex items-center gap-1.5"><StatusBadge kind="waiting" value={k} /><span className="font-semibold tabular-nums">{n}</span></li>
                ))}</ul>
              ) : <p className="text-muted">Nobody is waiting.</p>}
            </div>
          </div>
        </Card>
      </div>
    </section>
  );
}
