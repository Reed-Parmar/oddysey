import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Allocation } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import {
  DataTable, EmptyState, ErrorState, LoadingState, NotFound, PageHeader, ScoreBar, StatusBadge, type Column,
} from "@/components/shared";
import { Alert, Card } from "@/components/ui";
import { FactorTable, ProgressTable, ProjectDetailView } from "@/features/shared/views";

import { NotPublishedState, useCycleState } from "../common";

export function AllocationFactors({ allocation }: { allocation: Allocation }) {
  if (!allocation.factors) return <p className="text-xs text-muted">Manual allocation, no recommendation factors.</p>;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-primary">Why this match?</summary>
      <FactorTable factors={allocation.factors} />
    </details>
  );
}

const allocColumns: Column<Allocation>[] = [
  {
    key: "trainee", header: "Trainee", cell: (a) => (
      <Link className="text-primary" to={`/supervisor/trainees/${a.trainee.id}`}>
        {a.trainee.full_name}<span className="block text-xs text-muted">{a.trainee.trainee_code}</span>
      </Link>
    ),
  },
  { key: "trade", header: "Trade", cell: (a) => a.trainee.trade.name },
  { key: "score", header: "Match score", cell: (a) => (a.match_score == null ? "—" : <ScoreBar value={a.match_score} label="Match score" />) },
  {
    key: "source", header: "Source", cell: (a) => (
      <span className="flex flex-wrap gap-1">
        <StatusBadge kind="allocationSource" value={a.source} />
        {a.is_override && <StatusBadge kind="allocationSource" value="override" />}
      </span>
    ),
  },
  { key: "factors", header: "Factors", className: "min-w-64", cell: (a) => <AllocationFactors allocation={a} /> },
];

function TraineeSections({ projectId }: { projectId: string }) {
  const [sort, setSort] = useState("trainee_name");
  const [page, setPage] = useState(1);
  const aq = { project_id: projectId, sort: "trainee_name", page_size: 100 };
  const allocs = useQuery({
    queryKey: qk.allocations.list(aq),
    queryFn: () => call(api.GET("/api/v1/allocations", { params: { query: aq } })),
  });
  const pq = { project_id: projectId, sort, page, page_size: 20 };
  const progress = useQuery({
    queryKey: qk.progress.list(pq),
    queryFn: () => call(api.GET("/api/v1/progress", { params: { query: pq } })),
    placeholderData: keepPreviousData,
  });

  return (
    <>
      <Card title="Allocated trainees">
        {allocs.isLoading ? <LoadingState /> : allocs.error ? (
          <ErrorState error={allocs.error} onRetry={() => void allocs.refetch()} />
        ) : !allocs.data?.data.length ? (
          <EmptyState title="No trainees are allocated to this project." />
        ) : (
          <DataTable rows={allocs.data.data} columns={allocColumns} rowKey={(a) => a.id} caption="Allocated trainees" />
        )}
      </Card>
      <Card title="Progress">
        <ProgressTable
          rows={progress.data?.data ?? []} meta={progress.data?.meta} isLoading={progress.isLoading} error={progress.error}
          onRetry={() => void progress.refetch()} sort={sort} onSortChange={(s) => { setSort(s); setPage(1); }} onPageChange={setPage}
          showTraineeColumn showSupervisorColumn={false} getRowHref={(r) => `/supervisor/trainees/${r.trainee.id}`}
          emptyState={<EmptyState title="No trainees are allocated to this project." />}
        />
      </Card>
    </>
  );
}

export function ProjectDetailPage() {
  const { projectId = "" } = useParams();
  const { user } = useAuth();
  const cycleState = useCycleState();
  const project = useQuery({
    queryKey: qk.projects.detail(projectId),
    queryFn: () => call(api.GET("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId } } })),
  });

  if (project.isLoading || cycleState.isLoading) return <LoadingState />;
  if (project.error) return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  const p = project.data?.data;
  if (!p) return <NotFound />;
  const own = p.supervisor?.id === user?.id;

  return (
    <>
      <PageHeader title={p.title} description={<Link className="text-primary underline" to="/supervisor/projects">Back to my projects</Link>} />
      <div className="flex flex-col gap-4">
        <ProjectDetailView project={p} />
        {!own ? (
          <Alert variant="info">You are not the supervisor of this project.</Alert>
        ) : cycleState.error ? (
          <ErrorState error={cycleState.error} onRetry={() => void cycleState.refetch()} />
        ) : !cycleState.visible ? (
          <NotPublishedState cycle={cycleState.cycle} />
        ) : (
          <TraineeSections projectId={p.id} />
        )}
      </div>
    </>
  );
}
