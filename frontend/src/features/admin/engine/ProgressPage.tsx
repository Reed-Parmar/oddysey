import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Cycle, ProgressRow } from "@/api/types";
import {
  DataTable, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, StatusBadge, type Column,
} from "@/components/shared";
import { Input, Select } from "@/components/ui";
import { formatScore } from "@/lib/format";
import { LABELS } from "@/lib/statusLabels";

import { WithCycle } from "./common";
import { useDebounced, usePublishedProjects } from "./hooks";

export function AdminProgressPage() {
  return (
    <WithCycle title="Progress">
      {(cycle) => <ProgressBody cycle={cycle} />}
    </WithCycle>
  );
}

type ProgressStatus = ProgressRow["progress"];

/*
 * Columns mirror the shared ProgressTable, plus a link to the latest submission (admin.md §3.7). ProgressTable has a
 * single getRowHref slot, which links the trainee; the submission link needs its own column.
 */
const columns: Column<ProgressRow>[] = [
  { key: "trainee", header: "Trainee", sort: "trainee_name", cell: (r) => (
    <Link className="text-primary" to={`/admin/trainees/${r.trainee.id}`}>
      {r.trainee.full_name}<span className="block text-xs text-muted">{r.trainee.trainee_code} · {r.trainee.trade.name}</span>
    </Link>
  ) },
  { key: "project", header: "Project", sort: "project_title", cell: (r) => r.project ? (
    <Link className="text-primary" to={`/admin/projects/${r.project.id}`}>{r.project.title}<span className="block text-xs text-muted">{r.project.project_code}</span></Link>
  ) : <span className="text-muted">—</span> },
  { key: "sup", header: "Supervisor", cell: (r) => r.supervisor?.full_name ?? "—" },
  { key: "match", header: "Match", sort: "-match_score", cell: (r) => (
    <span className="flex flex-wrap items-center gap-1 tabular-nums">{formatScore(r.allocation?.match_score)}{r.allocation?.is_override && <StatusBadge kind="allocationSource" value="override" />}</span>
  ) },
  { key: "progress", header: "Status", cell: (r) => (
    <span className="flex flex-wrap gap-1"><StatusBadge kind="progress" value={r.progress} />{r.latest_submission?.is_late && <StatusBadge kind="late" value="late" />}</span>
  ) },
  { key: "latest", header: "Latest submission", cell: (r) => r.latest_submission
    ? <Link className="text-primary underline" to={`/admin/submissions/${r.latest_submission.id}`}>View v{r.latest_submission.version}</Link>
    : <span className="text-muted">—</span> },
  { key: "score", header: "Score", sort: "-total_score", cell: (r) => r.evaluation ? (
    <span className="flex items-center gap-1">{r.evaluation.total_score}{r.evaluation.grade && <StatusBadge kind="grade" value={r.evaluation.grade} />}</span>
  ) : "—" },
];

function ProgressBody({ cycle }: { cycle: Cycle }) {
  const ids = { q: useId(), status: useId(), trade: useId(), project: useId(), late: useId(), unalloc: useId() };
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<"" | ProgressStatus>("");
  const [tradeId, setTradeId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [lateOnly, setLateOnly] = useState(false);
  const [includeUnallocated, setIncludeUnallocated] = useState(true);
  const [sort, setSort] = useState("trainee_name");
  const [page, setPage] = useState(1);
  const dq = useDebounced(q.trim());

  const trades = useQuery({ queryKey: qk.trades.list(), queryFn: () => call(api.GET("/api/v1/trades")) });
  const projects = usePublishedProjects(cycle.id);

  const params = {
    cycle_id: cycle.id,
    include_unallocated: includeUnallocated,
    ...(status ? { progress: status } : {}),
    ...(tradeId ? { trade_id: tradeId } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    ...(lateOnly ? { late_only: true } : {}),
    ...(dq ? { q: dq } : {}),
    sort, page, page_size: 20,
  };
  const list = useQuery({
    queryKey: qk.progress.list(params),
    queryFn: () => call(api.GET("/api/v1/progress", { params: { query: params } })),
  });

  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const filtered = !!(status || tradeId || projectId || lateOnly || dq);

  return (
    <>
      <PageHeader title="Progress"
        description={<>Every trainee in <span className="font-medium">{cycle.name}</span>, from allocation to evaluation.</>} />
      <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.q} className="text-xs font-medium">Search trainee</label>
          <Input id={ids.q} type="search" placeholder="Name or code" maxLength={100} value={q} onChange={(e) => reset(setQ)(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.status} className="text-xs font-medium">Status</label>
          <Select id={ids.status} value={status} onChange={(e) => reset(setStatus)(e.target.value as typeof status)}>
            <option value="">Any status</option>
            {Object.entries(LABELS.progress).map(([v, [text]]) => <option key={v} value={v}>{text}</option>)}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.trade} className="text-xs font-medium">Trade</label>
          <Select id={ids.trade} value={tradeId} onChange={(e) => reset(setTradeId)(e.target.value)}>
            <option value="">All trades</option>
            {trades.data?.data.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.project} className="text-xs font-medium">Project</label>
          <Select id={ids.project} value={projectId} onChange={(e) => reset(setProjectId)(e.target.value)}>
            <option value="">All projects</option>
            {projects.data?.data.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </Select>
        </div>
        <label htmlFor={ids.late} className="flex min-h-10 items-center gap-2 text-sm">
          <input id={ids.late} type="checkbox" className="size-4" checked={lateOnly} onChange={(e) => reset(setLateOnly)(e.target.checked)} />
          Late submissions only
        </label>
        <label htmlFor={ids.unalloc} className="flex min-h-10 items-center gap-2 text-sm">
          <input id={ids.unalloc} type="checkbox" className="size-4" checked={includeUnallocated}
            onChange={(e) => reset(setIncludeUnallocated)(e.target.checked)} />
          Include unallocated trainees
        </label>
      </div>
      {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : !list.data?.data.length ? (
        filtered ? <EmptyState title="No trainees match these filters" /> : (
          <EmptyState title="No trainees in this cycle" action={<Link className="text-primary underline" to="/admin/trainees">Import trainees</Link>} />
        )
      ) : (
        <>
          <DataTable rows={list.data.data} columns={columns} rowKey={(r) => r.trainee.id} sort={sort} onSortChange={reset(setSort)} caption="Progress" />
          <Pagination meta={list.data.meta} onPageChange={setPage} />
        </>
      )}
    </>
  );
}
