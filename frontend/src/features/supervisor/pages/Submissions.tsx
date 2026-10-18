import { ArrowRight, CheckCircle, MagnifyingGlass } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Submission } from "@/api/types";
import {
  DataTable, DateTime, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, StatusBadge, type Column,
} from "@/components/shared";
import { Button, Select, buttonStyles } from "@/components/ui";

import { compact, FilterBar, NotPublishedState, PersonCell, ProjectFilter, useCycleState, useParamState } from "../common";

type Status = Submission["status"];
const STATUS_OPTIONS: [string, string][] = [
  ["all", "All statuses"], ["submitted", "Awaiting evaluation"], ["rework_requested", "Rework requested"], ["evaluated", "Evaluated"],
];
const VERSION_OPTIONS: [string, string][] = [["all", "All versions"], ["latest", "Latest version only"]];

/** Keeps each trainee's versions together (first-seen order, versions in the chosen sort direction) so v1 and v2 read as one history. */
function groupByTrainee(rows: Submission[], oldestFirst: boolean): Submission[] {
  const groups = new Map<string, Submission[]>();
  for (const s of rows) {
    const key = `${s.trainee.id}:${s.allocation_id}`;
    const g = groups.get(key);
    if (g) g.push(s);
    else groups.set(key, [s]);
  }
  return [...groups.values()].flatMap((g) => g.sort((a, b) => (oldestFirst ? a.version - b.version : b.version - a.version)));
}

const columns: Column<Submission>[] = [
  {
    key: "trainee", header: "Trainee", className: "min-w-52",
    cell: (s) => (
      <PersonCell name={s.trainee.full_name} meta={s.trainee.trainee_code} to={`/supervisor/submissions/${s.id}`}
        onLinkClick={(e) => e.stopPropagation()} />
    ),
  },
  { key: "project", header: "Project", className: "min-w-44", cell: (s) => <span>{s.project.title}<span className="block text-xs text-muted">{s.project.project_code}</span></span> },
  {
    key: "version", header: "Version",
    cell: (s) => <span className="inline-flex rounded-md border border-border bg-surface-2 px-2 py-0.5 text-xs font-semibold tabular-nums text-neutral">v{s.version}</span>,
  },
  {
    key: "submitted", header: "Submitted",
    cell: (s) => <span className="flex flex-wrap items-center gap-1.5 whitespace-nowrap text-muted"><DateTime value={s.submitted_at} />{s.is_late && <StatusBadge kind="late" value="late" />}</span>,
  },
  {
    key: "status", header: "Status",
    cell: (s) => <span className="flex flex-wrap gap-1"><StatusBadge kind="submission" value={s.status} />{s.evaluation?.grade && <StatusBadge kind="grade" value={s.evaluation.grade} />}</span>,
  },
  {
    key: "action", header: <span className="sr-only">Action</span>, className: "text-right",
    cell: (s) => (
      <Link
        to={`/supervisor/submissions/${s.id}`}
        onClick={(e) => e.stopPropagation()}
        className={buttonStyles(s.status === "submitted" ? "primary" : "ghost", "sm")}
      >
        {s.status === "submitted" ? "Evaluate" : "View"}
        <span className="sr-only"> {s.trainee.full_name}, version {s.version}</span>
        <ArrowRight aria-hidden size={14} />
      </Link>
    ),
  },
];

export function SubmissionsPage() {
  const navigate = useNavigate();
  const { get, set, page } = useParamState();
  const cycleState = useCycleState();
  const statusParam = get("status", "all");
  const status = STATUS_OPTIONS.some(([v]) => v === statusParam) ? statusParam : "all";
  const versions = get("versions") === "latest" ? "latest" : "all";
  const projectId = get("project_id");
  const sort = get("sort") === "submitted_at" ? "submitted_at" : "-submitted_at";
  const query = {
    sort, page, page_size: 50, latest_only: versions === "latest",
    ...compact({ status: status === "all" ? undefined : (status as Status), project_id: projectId }),
  };
  const subs = useQuery({
    queryKey: qk.submissions.list(query),
    queryFn: () => call(api.GET("/api/v1/submissions", { params: { query } })),
    enabled: cycleState.visible,
    placeholderData: keepPreviousData,
  });
  const isDefault = status === "all" && versions === "all" && !projectId;
  const total = subs.data?.meta.total;

  let body;
  if (cycleState.isLoading || (cycleState.visible && subs.isLoading)) body = <LoadingState />;
  else if (cycleState.error) body = <ErrorState error={cycleState.error} onRetry={() => void cycleState.refetch()} />;
  else if (!cycleState.visible) body = <NotPublishedState cycle={cycleState.cycle} />;
  else if (subs.error) body = <ErrorState error={subs.error} onRetry={() => void subs.refetch()} />;
  else if (!subs.data?.data.length) {
    body = isDefault ? (
      <EmptyState icon={<CheckCircle />} title="No submissions yet." description="Every version trainees submit on your projects will appear here." />
    ) : (
      <EmptyState icon={<MagnifyingGlass />} title="No submissions match these filters."
        action={<Button variant="secondary" onClick={() => set({ status: null, project_id: null, versions: null })}>Clear filters</Button>} />
    );
  } else {
    body = (
      <>
        <DataTable rows={groupByTrainee(subs.data.data, sort === "submitted_at")} columns={columns} rowKey={(s) => s.id} caption="Submissions"
          onRowClick={(s) => navigate(`/supervisor/submissions/${s.id}`)} />
        <Pagination meta={subs.data.meta} onPageChange={(n) => set({ page: String(n) }, false)} />
      </>
    );
  }

  const statusLabel = STATUS_OPTIONS.find(([v]) => v === status)?.[1] ?? "";

  return (
    <>
      <PageHeader
        title="Evaluations"
        description="Every version each trainee submitted on your projects, grouped per trainee. Evaluate the oldest waiting work first."
      />
      <FilterBar className="sm:grid-cols-2 lg:grid-cols-4">
        <Select aria-label="Status" value={status} onChange={(e) => set({ status: e.target.value === "all" ? null : e.target.value })}>
          {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <Select aria-label="Versions" value={versions} onChange={(e) => set({ versions: e.target.value === "all" ? null : e.target.value })}>
          {VERSION_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <ProjectFilter id="sub-project" value={projectId} onChange={(v) => set({ project_id: v })} />
        <Select aria-label="Sort" value={sort} onChange={(e) => set({ sort: e.target.value === "-submitted_at" ? null : e.target.value })}>
          <option value="-submitted_at">Newest first</option>
          <option value="submitted_at">Oldest first</option>
        </Select>
      </FilterBar>
      {cycleState.visible && total != null && total > 0 && (
        <p className="mb-3 text-sm text-muted" aria-live="polite">
          <span className="font-semibold text-text tabular-nums">{total}</span> {total === 1 ? "submission" : "submissions"} · {statusLabel} · {versions === "all" ? "all versions" : "latest version only"}
        </p>
      )}
      {body}
    </>
  );
}
