import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Submission } from "@/api/types";
import {
  DataTable, DateTime, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, StatusBadge, type Column,
} from "@/components/shared";
import { Button, Select } from "@/components/ui";

import { compact, NotPublishedState, ProjectFilter, useCycleState, useParamState } from "../common";

type Status = Submission["status"];
const STATUS_OPTIONS: [string, string][] = [
  ["submitted", "Awaiting evaluation"], ["rework_requested", "Rework requested"], ["evaluated", "Evaluated"], ["all", "All"],
];

const columns: Column<Submission>[] = [
  { key: "trainee", header: "Trainee", cell: (s) => <Link className="text-primary" to={`/supervisor/submissions/${s.id}`} onClick={(e) => e.stopPropagation()}>{s.trainee.full_name}<span className="block text-xs text-muted">{s.trainee.trainee_code}</span></Link> },
  { key: "project", header: "Project", cell: (s) => <span>{s.project.title}<span className="block text-xs text-muted">{s.project.project_code}</span></span> },
  { key: "version", header: "Version", cell: (s) => `v${s.version}` },
  { key: "submitted", header: "Submitted", cell: (s) => <span className="flex flex-wrap items-center gap-1"><DateTime value={s.submitted_at} />{s.is_late && <StatusBadge kind="late" value="late" />}</span> },
  { key: "status", header: "Status", cell: (s) => <span className="flex flex-wrap gap-1"><StatusBadge kind="submission" value={s.status} />{s.evaluation?.grade && <StatusBadge kind="grade" value={s.evaluation.grade} />}</span> },
];

export function SubmissionsPage() {
  const navigate = useNavigate();
  const { get, set, page } = useParamState();
  const cycleState = useCycleState();
  const statusParam = get("status", "submitted");
  const status = STATUS_OPTIONS.some(([v]) => v === statusParam) ? statusParam : "submitted";
  const projectId = get("project_id");
  const sort = get("sort") === "submitted_at" ? "submitted_at" : "-submitted_at";
  const query = {
    sort, page, page_size: 20,
    ...compact({ status: status === "all" ? undefined : (status as Status), project_id: projectId }),
  };
  const subs = useQuery({
    queryKey: qk.submissions.list(query),
    queryFn: () => call(api.GET("/api/v1/submissions", { params: { query } })),
    enabled: cycleState.visible,
    placeholderData: keepPreviousData,
  });
  const isDefault = status === "submitted" && !projectId;

  let body;
  if (cycleState.isLoading || (cycleState.visible && subs.isLoading)) body = <LoadingState />;
  else if (cycleState.error) body = <ErrorState error={cycleState.error} onRetry={() => void cycleState.refetch()} />;
  else if (!cycleState.visible) body = <NotPublishedState cycle={cycleState.cycle} />;
  else if (subs.error) body = <ErrorState error={subs.error} onRetry={() => void subs.refetch()} />;
  else if (!subs.data?.data.length) {
    body = isDefault ? <EmptyState title="Nothing is waiting for evaluation." /> : (
      <EmptyState title="No submissions match these filters."
        action={<Button variant="secondary" onClick={() => set({ status: null, project_id: null })}>Clear filters</Button>} />
    );
  } else {
    body = (
      <>
        <DataTable rows={subs.data.data} columns={columns} rowKey={(s) => s.id} caption="Submissions"
          onRowClick={(s) => navigate(`/supervisor/submissions/${s.id}`)} />
        <Pagination meta={subs.data.meta} onPageChange={(n) => set({ page: String(n) }, false)} />
      </>
    );
  }

  return (
    <>
      <PageHeader title="Evaluations" description="Latest version of each trainee's submission on your projects." />
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        <Select aria-label="Status" value={status} onChange={(e) => set({ status: e.target.value === "submitted" ? null : e.target.value })}>
          {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </Select>
        <ProjectFilter id="sub-project" value={projectId} onChange={(v) => set({ project_id: v })} />
        <Select aria-label="Sort" value={sort} onChange={(e) => set({ sort: e.target.value === "-submitted_at" ? null : e.target.value })}>
          <option value="-submitted_at">Newest first</option>
          <option value="submitted_at">Oldest first</option>
        </Select>
      </div>
      {body}
    </>
  );
}
