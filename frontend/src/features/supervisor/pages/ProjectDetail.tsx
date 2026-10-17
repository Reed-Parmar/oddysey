import { ChartBar, Gauge, Info, UsersThree } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Allocation } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import {
  BackLink, DataTable, EmptyState, ErrorState, LoadingState, NotFound, PageHeader, ScoreBar, StatusBadge, type Column,
} from "@/components/shared";
import { Alert, Card } from "@/components/ui";
import { FactorTable, ProjectDetailView } from "@/features/shared/views";

import { CapacitySummary, NotPublishedState, PersonCell, SupervisorProgressTable, useCycleState } from "../common";

export function AllocationFactors({ allocation }: { allocation: Allocation }) {
  if (!allocation.factors) return <p className="text-xs text-muted">Manual allocation, no recommendation factors.</p>;
  return (
    <details className="group text-sm">
      <summary className="cursor-pointer font-medium text-primary hover:underline">Why this match?</summary>
      <FactorTable factors={allocation.factors} />
    </details>
  );
}

const allocColumns: Column<Allocation>[] = [
  {
    key: "trainee", header: "Trainee", className: "min-w-52", cell: (a) => (
      <PersonCell name={a.trainee.full_name} meta={a.trainee.trainee_code} to={`/supervisor/trainees/${a.trainee.id}`} />
    ),
  },
  { key: "trade", header: "Trade", cell: (a) => a.trainee.trade.name },
  { key: "score", header: "Match score", cell: (a) => (a.match_score == null ? <span className="text-muted">—</span> : <ScoreBar value={a.match_score} label="Match score" />) },
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
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <UsersThree aria-hidden size={18} className="text-primary" /> Allocated trainees
          {allocs.data && <span className="text-sm font-normal text-muted tabular-nums">({allocs.data.data.length})</span>}
        </h2>
        {allocs.isLoading ? <LoadingState /> : allocs.error ? (
          <ErrorState error={allocs.error} onRetry={() => void allocs.refetch()} />
        ) : !allocs.data?.data.length ? (
          <EmptyState icon={<UsersThree />} title="No trainees are allocated to this project." />
        ) : (
          <DataTable rows={allocs.data.data} columns={allocColumns} rowKey={(a) => a.id} caption="Allocated trainees" />
        )}
      </section>
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-base font-semibold">
          <ChartBar aria-hidden size={18} className="text-primary" /> Progress
        </h2>
        <SupervisorProgressTable
          rows={progress.data?.data ?? []} meta={progress.data?.meta} isLoading={progress.isLoading} error={progress.error}
          onRetry={() => void progress.refetch()} sort={sort} onSortChange={(s) => { setSort(s); setPage(1); }} onPageChange={setPage}
          emptyState={<EmptyState icon={<UsersThree />} title="No trainees are allocated to this project." />}
        />
      </section>
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
      <PageHeader
        eyebrow={<BackLink to="/supervisor/projects">Back to my projects</BackLink>}
        title={p.title}
        description={<span className="inline-flex flex-wrap items-center gap-2">{p.project_code} <StatusBadge kind="project" value={p.status} /></span>}
      />
      <div className="space-y-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <ProjectDetailView project={p} />
          <Card icon={<Gauge />} title="Capacity" description="Trainees allocated against seats." className="self-start">
            <CapacitySummary project={p} />
          </Card>
        </div>
        {!own ? (
          <Alert variant="info" icon={<Info />}>You are not the supervisor of this project.</Alert>
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
