/** Supervisor-module helpers shared by its pages. */
import { CalendarBlank, Hourglass, Target, UsersThree } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Cycle, PageMeta, ProgressRow, Project } from "@/api/types";
import {
  Avatar, DataTable, EmptyState, ErrorState, LoadingState, Meter, Pagination, ScoreBar, StatusBadge, type Column,
} from "@/components/shared";
import { Select, cx } from "@/components/ui";
import { useCurrentCycle } from "@/app/AppShell";
import { formatScore } from "@/lib/format";
import { label } from "@/lib/statusLabels";

/** Supervisors see trainees/allocations/submissions only once the cycle is published or archived. */
export const isVisibleCycle = (c: Cycle | null | undefined) => c?.status === "published" || c?.status === "archived";

export function useCycleState() {
  const q = useCurrentCycle();
  const cycle = q.data?.data ?? null;
  return { ...q, cycle, visible: isVisibleCycle(cycle) };
}

export function NotPublishedState({ cycle }: { cycle: Cycle | null }) {
  if (!cycle) return <NoCycleState />;
  return (
    <EmptyState
      icon={<Hourglass />}
      title="Allocations are not published yet"
      description={`The cycle "${cycle.name}" is in ${label("cycle", cycle.status)[0].toLowerCase()}. Trainees, submissions and progress appear here once the programme team publishes allocations.`}
    />
  );
}

export function NoCycleState() {
  return <EmptyState icon={<CalendarBlank />} title="There is no active cycle yet" description="The programme team will set one up." />;
}

const MY_PROJECTS_PARAMS = { mine: true, sort: "title", page_size: 100 } as const;

/** Own projects (PRJ-01 mine=true), first 100 — used for filter dropdowns and the dashboard. */
export function useMyProjects() {
  return useQuery({
    queryKey: qk.projects.list(MY_PROJECTS_PARAMS),
    queryFn: () => call(api.GET("/api/v1/projects", { params: { query: MY_PROJECTS_PARAMS } })),
  });
}

export function ProjectFilter({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const projects = useMyProjects();
  return (
    <Select id={id} aria-label="Project" value={value} onChange={(e) => onChange(e.target.value)} disabled={projects.isLoading}>
      <option value="">All my projects</option>
      {(projects.data?.data ?? []).map((p) => (
        <option key={p.id} value={p.id}>{p.project_code} · {p.title}</option>
      ))}
    </Select>
  );
}

/** URL search-param backed filter state (supervisor.md §3: filters live in the URL). Changing a filter resets `page`. */
export function useParamState() {
  const [params, setParams] = useSearchParams();
  const get = useCallback((key: string, fallback = "") => params.get(key) ?? fallback, [params]);
  const set = useCallback(
    (updates: Record<string, string | null>, resetPage = true) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(updates)) {
          if (v === null || v === "") next.delete(k);
          else next.set(k, v);
        }
        if (resetPage && !("page" in updates)) next.delete("page");
        return next;
      }, { replace: true });
    },
    [setParams],
  );
  const page = Math.max(1, Number(params.get("page")) || 1);
  return { get, set, page, params };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Drops empty-string / undefined entries so query keys and query strings only carry real filters. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined && v !== null)) as Partial<T>;
}

/* ---------------------------------------------------------------- presentational helpers */

/** Card-style toolbar that groups list filters; the grid wraps on small screens. */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div role="group" aria-label="Filters" className={cx("mb-4 grid gap-3 rounded-xl border border-border bg-surface p-3 shadow-card", className)}>
      {children}
    </div>
  );
}

/** Avatar + visible name + secondary line. With `to`, the name is the link (its accessible name is the trainee name). */
export function PersonCell({ name, meta, to, onLinkClick }: {
  name: string; meta?: ReactNode; to?: string; onLinkClick?: (e: MouseEvent<HTMLAnchorElement>) => void;
}) {
  return (
    <span className="flex min-w-0 items-center gap-3">
      <Avatar name={name} size="sm" />
      <span className="min-w-0">
        {to ? (
          <Link className="font-semibold text-text transition-colors hover:text-primary hover:underline" to={to} onClick={onLinkClick}>
            {name}
          </Link>
        ) : <span className="font-semibold text-text">{name}</span>}
        {meta && <span className="block truncate text-xs text-muted">{meta}</span>}
      </span>
    </span>
  );
}

/** Supervisor project tile: code, title, status, trade/difficulty and a capacity meter. */
export function SupervisorProjectCard({ project: p }: { project: Project }) {
  const allocated = p.stats?.allocated_count;
  const full = allocated != null && allocated >= p.max_trainees;
  return (
    <Link
      to={`/supervisor/projects/${p.id}`}
      className="group flex h-full flex-col gap-4 rounded-xl border border-border bg-surface p-5 shadow-card transition-[border-color,box-shadow] duration-150 hover:border-primary/40 hover:shadow-raised"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold tracking-wide text-muted uppercase">{p.project_code}</p>
          <h3 className="mt-0.5 text-base font-semibold text-text transition-colors group-hover:text-primary">{p.title}</h3>
        </div>
        <StatusBadge kind="project" value={p.status} />
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs">
        <StatusBadge kind="difficulty" value={p.difficulty} />
        <span className="rounded-full border border-border bg-surface-2 px-2.5 py-0.5 font-medium text-neutral">{p.target_trade.name}</span>
        <span className="rounded-full border border-border bg-surface-2 px-2.5 py-0.5 font-medium text-neutral tabular-nums">
          Min practical {formatScore(p.min_practical_score)}%
        </span>
      </div>
      <div className="mt-auto space-y-2">
        <Meter
          label="Capacity"
          value={allocated ?? 0}
          max={p.max_trainees}
          tone={full ? "success" : "primary"}
          valueLabel={allocated == null ? `— / ${p.max_trainees}` : `${allocated} / ${p.max_trainees} allocated`}
        />
        {p.stats?.eligible_trainee_count != null && (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <UsersThree aria-hidden size={14} />
            <span><span className="tabular-nums">{p.stats.eligible_trainee_count}</span> eligible trainees (latest run)</span>
          </p>
        )}
      </div>
    </Link>
  );
}

/** Capacity summary for a project detail page. */
export function CapacitySummary({ project: p }: { project: Project }) {
  const allocated = p.stats?.allocated_count ?? 0;
  const left = Math.max(0, p.max_trainees - allocated);
  return (
    <div className="space-y-4">
      <Meter label="Seats filled" value={allocated} max={p.max_trainees} tone={left === 0 ? "success" : "primary"} />
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-lg bg-surface-2 p-3">
          <dt className="text-xs text-muted">Seats left</dt>
          <dd className="font-heading text-xl font-semibold tabular-nums">{left}</dd>
        </div>
        <div className="rounded-lg bg-surface-2 p-3">
          <dt className="flex items-center gap-1 text-xs text-muted"><Target aria-hidden size={12} /> Eligible</dt>
          <dd className="font-heading text-xl font-semibold tabular-nums">{p.stats?.eligible_trainee_count ?? "—"}</dd>
        </div>
      </dl>
    </div>
  );
}

/** Progress table for supervisors: same columns and sorts as the shared ProgressTable, plus avatars and score bars. */
export function SupervisorProgressTable({ rows, meta, onPageChange, sort, onSortChange, isLoading, error, onRetry, emptyState }: {
  rows: ProgressRow[]; meta?: PageMeta; onPageChange?: (p: number) => void; sort?: string; onSortChange?: (s: string) => void;
  isLoading?: boolean; error?: unknown; onRetry?: () => void; emptyState?: ReactNode;
}) {
  if (isLoading) return <LoadingState />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (!rows.length) return <>{emptyState ?? <EmptyState title="No progress rows yet" />}</>;
  const cols: Column<ProgressRow>[] = [
    {
      key: "trainee", header: "Trainee", sort: "trainee_name", className: "min-w-52",
      cell: (r) => <PersonCell name={r.trainee.full_name} meta={`${r.trainee.trainee_code} · ${r.trainee.trade.name}`} to={`/supervisor/trainees/${r.trainee.id}`} />,
    },
    {
      key: "project", header: "Project", sort: "project_title", className: "min-w-44",
      cell: (r) => r.project
        ? <span>{r.project.title}<span className="block text-xs text-muted">{r.project.project_code}</span></span>
        : <span className="text-muted">—</span>,
    },
    {
      key: "match", header: "Match", sort: "-match_score",
      cell: (r) => (
        <span className="flex flex-wrap items-center gap-1.5">
          {r.allocation?.match_score == null
            ? <span className="text-muted">—</span>
            : <span className="font-semibold tabular-nums">{formatScore(r.allocation.match_score)}</span>}
          {r.allocation?.is_override && <StatusBadge kind="allocationSource" value="override" />}
        </span>
      ),
    },
    {
      key: "progress", header: "Status",
      cell: (r) => (
        <span className="flex flex-wrap gap-1">
          <StatusBadge kind="progress" value={r.progress} />
          {r.latest_submission?.is_late && <StatusBadge kind="late" value="late" />}
        </span>
      ),
    },
    {
      key: "version", header: "Latest version",
      cell: (r) => r.latest_submission
        ? <Link className="font-medium text-primary tabular-nums hover:underline" to={`/supervisor/submissions/${r.latest_submission.id}`}>v{r.latest_submission.version}</Link>
        : <span className="text-muted">—</span>,
    },
    {
      key: "score", header: "Score", sort: "-total_score", className: "min-w-56",
      cell: (r) => r.evaluation?.total_score != null ? (
        <span className="flex flex-wrap items-center gap-2">
          <ScoreBar value={r.evaluation.total_score} tone="auto" />
          {r.evaluation.grade && <StatusBadge kind="grade" value={r.evaluation.grade} />}
        </span>
      ) : r.evaluation?.grade ? <StatusBadge kind="grade" value={r.evaluation.grade} /> : <span className="text-muted">—</span>,
    },
  ];
  return (
    <>
      <DataTable rows={rows} columns={cols} rowKey={(r) => r.trainee.id} sort={sort} onSortChange={onSortChange} caption="Progress" />
      {onPageChange && <Pagination meta={meta} onPageChange={onPageChange} />}
    </>
  );
}
