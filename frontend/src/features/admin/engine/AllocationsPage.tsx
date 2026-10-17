import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { ApiError } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Allocation, AllocationRun, Cycle } from "@/api/types";
import {
  ConfirmDialog, DataTable, DateTime, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, StatusBadge,
  useToast, type Column,
} from "@/components/shared";
import { Alert, Button, Card, Input, Select } from "@/components/ui";
import { FactorTable } from "@/features/shared/views";
import { formatScore } from "@/lib/format";

import { AllocationDialog, type AllocationDialogTarget } from "./AllocationDialog";
import { Reason, WithCycle } from "./common";
import {
  invalidateAllocationWrites, invalidateCycleTransition, useCompletedRun, useDebounced, useLatestRun, usePublishedProjects,
} from "./hooks";
import { UNALLOCATED_REASON_LABEL, allocationErrorText, detailMessages, isActiveRun } from "./lib";

export function AllocationsPage() {
  return (
    <WithCycle title="Allocations">
      {(cycle) => <AllocationsBody cycle={cycle} />}
    </WithCycle>
  );
}

function AllocationsBody({ cycle }: { cycle: Cycle }) {
  const [dialog, setDialog] = useState<AllocationDialogTarget | null>(null);
  const [lastRun, setLastRun] = useState<AllocationRun | null>(null);
  const latest = useLatestRun(cycle.id);
  const runActive = isActiveRun(latest.data?.data?.status);
  const archived = cycle.status === "archived";

  const totalParams = { cycle_id: cycle.id, page_size: 1 };
  const total = useQuery({
    queryKey: qk.allocations.list(totalParams),
    queryFn: () => call(api.GET("/api/v1/allocations", { params: { query: totalParams } })),
  });
  const allocationCount = total.data?.meta.total;

  return (
    <>
      <PageHeader title="Allocations"
        description={<>Cycle <span className="font-medium">{cycle.name}</span> <StatusBadge kind="cycle" value={cycle.status} /></>}
        actions={!archived && (
          <Button variant="secondary" onClick={() => setDialog({ mode: "create" })}>Allocate manually</Button>
        )} />
      <div className="flex flex-col gap-5">
        {archived ? (
          <Alert variant="info" title="Cycle is archived">Allocations are read-only.</Alert>
        ) : (
          <PublishPanel cycle={cycle} allocationCount={allocationCount} runActive={runActive} />
        )}
        {cycle.status === "draft" && (
          <AutoAllocatePanel cycle={cycle} runActive={runActive} lastRun={lastRun} onRun={setLastRun}
            onAllocate={(t) => setDialog({ mode: "create", trainee: t })} />
        )}
        {cycle.status === "published" && (
          <Reason>Auto-allocation is only available while planning. Manual allocate, reassign and remove still work for trainees without submissions.</Reason>
        )}
        <CapacityPanel cycleId={cycle.id} />
        <AllocationTable cycle={cycle} onReassign={(a) => setDialog({ mode: "reassign", allocation: a })} />
      </div>
      <AllocationDialog target={dialog} cycleId={cycle.id} onClose={() => setDialog(null)} />
    </>
  );
}

// ---------------------------------------------------------------- publish / return to planning (CYC-06)

function PublishPanel({ cycle, allocationCount, runActive }: { cycle: Cycle; allocationCount?: number; runActive: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const to = cycle.status === "draft" ? "published" : "draft";

  const subParams = { cycle_id: cycle.id, page_size: 1 };
  const subs = useQuery({
    queryKey: qk.submissions.list(subParams),
    queryFn: () => call(api.GET("/api/v1/submissions", { params: { query: subParams } })),
    enabled: cycle.status === "published",
  });
  const subCount = subs.data?.meta.total ?? 0;

  const m = useMutation({
    mutationFn: () => call(api.POST("/api/v1/cycles/{cycle_id}/transition", { params: { path: { cycle_id: cycle.id } }, body: { to } })),
    onMutate: () => setError(null),
    onSuccess: () => {
      invalidateCycleTransition(qc);
      toast.success(to === "published" ? "Allocations published" : "Returned to planning; allocations are hidden again");
      setConfirm(false);
    },
    onError: (e) => { setError(e); setConfirm(false); },
  });

  const publishReason = runActive ? "Wait for the recommendation run to finish" : allocationCount === 0 ? "Create at least one allocation" : null;
  const unpublishReason = subCount > 0 ? `Submissions exist (${subCount}); returning to planning is blocked` : null;

  return (
    <>
      {cycle.status === "draft" ? (
        <Card title="Publish">
          <p className="mb-3 text-sm text-muted">
            This is a draft. Students and supervisors never see draft allocations; they see them only after you publish.
          </p>
          <div className="flex flex-col items-start gap-1">
            <Button disabled={!!publishReason || allocationCount === undefined} loading={m.isPending} onClick={() => setConfirm(true)}>
              Publish allocations
            </Button>
            <Reason>{publishReason}</Reason>
          </div>
        </Card>
      ) : (
        <Alert variant="success" title="Allocations are published">
          <p>Trainees and supervisors can see their allocations.</p>
          <div className="mt-2 flex flex-col items-start gap-1">
            <Button size="sm" variant="secondary" disabled={!!unpublishReason} loading={m.isPending} onClick={() => setConfirm(true)}>
              Return to planning
            </Button>
            {unpublishReason && <p className="text-xs">{unpublishReason}</p>}
          </div>
        </Alert>
      )}
      {error != null && (
        <Alert variant="danger" title={to === "published" ? "Cannot publish" : "Cannot return to planning"}>
          <ul className="list-disc pl-5">{detailMessages(error).map((x) => <li key={x}>{x}</li>)}</ul>
        </Alert>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} loading={m.isPending} onConfirm={() => m.mutate()}
        title={to === "published" ? "Publish allocations?" : "Return to planning?"}
        confirmLabel={to === "published" ? "Publish" : "Return to planning"}
        message={to === "published"
          ? <p>Trainees and supervisors will see their allocations. You can still reassign trainees who have not submitted.</p>
          : <p>Allocations will be hidden from trainees and supervisors again while you re-plan. This only works while no submissions exist.</p>} />
    </>
  );
}

// ---------------------------------------------------------------- auto-allocate (ALLOC-02)

function AutoAllocatePanel({ cycle, runActive, lastRun, onRun, onAllocate }: {
  cycle: Cycle; runActive: boolean; lastRun: AllocationRun | null; onRun: (r: AllocationRun) => void;
  onAllocate: (t: { id: string; full_name: string; trainee_code: string }) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const completed = useCompletedRun(cycle.id);
  const hasCompleted = !!completed.data?.data;

  const m = useMutation({
    mutationFn: () => call(api.POST("/api/v1/cycles/{cycle_id}/allocation-runs", { params: { path: { cycle_id: cycle.id } } })),
    onMutate: () => setError(null),
    onSuccess: (res) => {
      invalidateAllocationWrites(qc);
      onRun(res.data);
      toast.success(`Auto-allocated ${res.data.allocated_count} trainees`);
      setConfirm(false);
    },
    onError: (e) => {
      setError(e);
      setConfirm(false);
      if (e instanceof ApiError && e.code === "RUN_IN_PROGRESS") void qc.invalidateQueries({ queryKey: qk.recommendationRuns.latest(cycle.id) });
    },
  });

  const reason = runActive ? "Recommendation run in progress" : completed.isSuccess && !hasCompleted ? "Run recommendations first" : null;
  const code = error instanceof ApiError ? error.code : null;

  return (
    <Card title="Auto-allocate">
      <p className="mb-3 text-sm text-muted">
        Places as many trainees as possible, then maximises the total match score within capacity, using eligible pairs from the latest completed recommendation run.
      </p>
      <div className="flex flex-col items-start gap-1">
        <Button disabled={!!reason || completed.isLoading} loading={m.isPending} onClick={() => setConfirm(true)}>Auto-allocate</Button>
        <Reason>{reason}{reason === "Run recommendations first" && <> · <Link className="text-primary underline" to="/admin/recommendations">Go to recommendations</Link></>}</Reason>
      </div>
      {error != null && (
        <div className="mt-3">
          <Alert variant="danger" title="Auto-allocate failed">
            {code === "NO_RECOMMENDATIONS" ? (
              <>Run recommendations first. <Link className="underline" to="/admin/recommendations">Go to recommendations</Link></>
            ) : code === "INVALID_STATE" ? (
              <ul className="list-disc pl-5">{detailMessages(error).map((x) => <li key={x}>{x}</li>)}</ul>
            ) : allocationErrorText(error)}
          </Alert>
        </div>
      )}
      {lastRun ? <RunSummary run={lastRun} onAllocate={onAllocate} /> : (
        <p className="mt-3 text-sm text-muted">Auto-allocate has not run in this session.</p>
      )}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} loading={m.isPending} onConfirm={() => m.mutate()}
        title="Run auto-allocation?" confirmLabel="Auto-allocate"
        message={<>
          <p>Auto-allocate places as many trainees as possible first, then maximises the total match score, within capacity, using only eligible pairs from the latest completed recommendation run (re-checked against current trainee and project data).</p>
          <p className="mt-2">Existing <strong>Auto</strong> allocations are replaced; <strong>Manual</strong> allocations are kept.</p>
        </>} />
    </Card>
  );
}

function RunSummary({ run, onAllocate }: { run: AllocationRun; onAllocate: (t: { id: string; full_name: string; trainee_code: string }) => void }) {
  return (
    <div className="mt-4 flex flex-col gap-3" aria-live="polite">
      <p className="text-xs text-muted">Last run <DateTime value={run.ran_at} /></p>
      <dl className="grid grid-cols-3 gap-3 text-sm">
        <div className="rounded-md border border-border p-2"><dt className="text-xs text-muted">Allocated</dt><dd className="font-semibold tabular-nums">{run.allocated_count}</dd></div>
        <div className="rounded-md border border-border p-2"><dt className="text-xs text-muted">Manual kept</dt><dd className="font-semibold tabular-nums">{run.manual_kept_count}</dd></div>
        <div className="rounded-md border border-border p-2"><dt className="text-xs text-muted">Avg match</dt><dd className="font-semibold tabular-nums">{formatScore(run.average_match_score)}</dd></div>
      </dl>
      {run.unallocated_trainees.length > 0 ? (
        <div>
          <h3 className="mb-2 text-sm font-medium">Unallocated trainees ({run.unallocated_trainees.length})</h3>
          <ul className="divide-y divide-border rounded-md border border-border text-sm">
            {run.unallocated_trainees.map((t) => (
              <li key={t.trainee_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  <Link className="text-primary" to={`/admin/trainees/${t.trainee_id}`}>{t.full_name}</Link>
                  <span className="text-muted"> · {t.trainee_code} · {UNALLOCATED_REASON_LABEL[t.reason]}</span>
                </span>
                <Button size="sm" variant="secondary" onClick={() => onAllocate({ id: t.trainee_id, full_name: t.full_name, trainee_code: t.trainee_code })}>
                  Allocate manually
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : <p className="text-sm text-success">Every eligible trainee was placed.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- capacity (PRJ-01 stats)

function CapacityPanel({ cycleId }: { cycleId: string }) {
  const projects = usePublishedProjects(cycleId);
  const rows = projects.data?.data ?? [];
  const used = rows.reduce((s, p) => s + (p.stats?.allocated_count ?? 0), 0);
  const cap = rows.reduce((s, p) => s + p.max_trainees, 0);
  return (
    <Card>
      <details>
        <summary className="cursor-pointer font-semibold">
          Project capacity {projects.isSuccess && <span className="font-normal text-muted">· {used} / {cap} places used across {rows.length} published projects</span>}
        </summary>
        <div className="mt-3">
          {projects.isLoading ? <LoadingState /> : projects.error ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} /> : !rows.length ? (
            <p className="text-sm text-muted">No published projects. <Link className="text-primary underline" to="/admin/projects">Publish projects</Link></p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {rows.map((p) => {
                const n = p.stats?.allocated_count ?? 0;
                const pct = p.max_trainees ? Math.min(100, (n / p.max_trainees) * 100) : 0;
                return (
                  <li key={p.id} className="rounded-md border border-border p-2 text-sm">
                    <div className="flex justify-between gap-2">
                      <Link className="truncate text-primary" to={`/admin/projects/${p.id}`}>{p.title}</Link>
                      <span className="shrink-0 tabular-nums">{n} / {p.max_trainees}</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-neutral-bg" aria-hidden>
                      <div className={`h-full ${n >= p.max_trainees ? "bg-warning" : "bg-primary"}`} style={{ width: `${pct}%` }} />
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </details>
    </Card>
  );
}

// ---------------------------------------------------------------- allocation table (ALLOC-01, ALLOC-05)

function AllocationTable({ cycle, onReassign }: { cycle: Cycle; onReassign: (a: Allocation) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ids = { q: useId(), project: useId(), source: useId(), override: useId(), sort: useId() };
  const [q, setQ] = useState("");
  const [projectId, setProjectId] = useState("");
  const [source, setSource] = useState<"" | "auto" | "manual">("");
  const [override, setOverride] = useState<"" | "true" | "false">("");
  const [sort, setSort] = useState("project_title");
  const [page, setPage] = useState(1);
  const [removing, setRemoving] = useState<Allocation | null>(null);
  const dq = useDebounced(q.trim());
  const projects = usePublishedProjects(cycle.id);
  const archived = cycle.status === "archived";

  const params = {
    cycle_id: cycle.id,
    ...(dq ? { q: dq } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    ...(source ? { source } : {}),
    ...(override ? { is_override: override === "true" } : {}),
    sort, page, page_size: 20,
  };
  const list = useQuery({
    queryKey: qk.allocations.list(params),
    queryFn: () => call(api.GET("/api/v1/allocations", { params: { query: params } })),
  });

  const remove = useMutation({
    mutationFn: (a: Allocation) => call(api.DELETE("/api/v1/allocations/{allocation_id}", { params: { path: { allocation_id: a.id } } })),
    onSuccess: (_r, a) => {
      invalidateAllocationWrites(qc);
      toast.success(`Removed ${a.trainee.full_name}'s allocation`);
      setRemoving(null);
    },
    onError: (e) => {
      toast.error(allocationErrorText(e));
      if (e instanceof ApiError && e.status === 409) invalidateAllocationWrites(qc);
      setRemoving(null);
    },
  });

  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  const cols: Column<Allocation>[] = [
    { key: "trainee", header: "Trainee", sort: "trainee_name", cell: (a) => (
      <Link className="text-primary" to={`/admin/trainees/${a.trainee.id}`}>
        {a.trainee.full_name}<span className="block text-xs text-muted">{a.trainee.trainee_code} · {a.trainee.trade.name}</span>
      </Link>
    ) },
    { key: "project", header: "Project", sort: "project_title", cell: (a) => (
      <Link className="text-primary" to={`/admin/projects/${a.project.id}`}>
        {a.project.title}<span className="block text-xs text-muted">{a.project.project_code}</span>
      </Link>
    ) },
    { key: "sup", header: "Supervisor", cell: (a) => a.project.supervisor ? (
      <span>{a.project.supervisor.full_name}{a.project.supervisor.department && <span className="block text-xs text-muted">{a.project.supervisor.department}</span>}</span>
    ) : <span className="text-muted">Not assigned</span> },
    { key: "score", header: "Match", sort: "-match_score", cell: (a) => <span className="tabular-nums">{formatScore(a.match_score)}</span> },
    { key: "source", header: "Source", cell: (a) => (
      <div className="flex flex-col items-start gap-1">
        <span className="flex flex-wrap gap-1">
          <StatusBadge kind="allocationSource" value={a.source} />
          {a.is_override && <StatusBadge kind="allocationSource" value="override" />}
        </span>
        {a.is_override && a.override_reason && <span className="max-w-56 text-xs text-muted">“{a.override_reason}”</span>}
        <span className="text-xs text-muted">by {a.created_by.full_name} · <DateTime value={a.updated_at} dateOnly /></span>
      </div>
    ) },
    { key: "factors", header: "Why", cell: (a) => a.factors ? (
      <details className="min-w-48 text-sm"><summary className="cursor-pointer text-primary">Factors</summary><FactorTable factors={a.factors} /></details>
    ) : <span className="text-xs text-muted">Manual allocation without a recommendation: match score only</span> },
    ...(archived ? [] : [{ key: "actions", header: <span className="sr-only">Actions</span>, cell: (a: Allocation) => (
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="secondary" onClick={() => onReassign(a)}>Reassign</Button>
        <Button size="sm" variant="ghost" className="text-danger" onClick={() => setRemoving(a)}>Remove</Button>
      </div>
    ) }]),
  ];

  return (
    <Card title="Allocation table">
      <div className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <div className="flex flex-col gap-1 lg:col-span-1">
          <label htmlFor={ids.q} className="text-xs font-medium">Search trainee</label>
          <Input id={ids.q} type="search" placeholder="Name or code" maxLength={100} value={q} onChange={(e) => reset(setQ)(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.project} className="text-xs font-medium">Project</label>
          <Select id={ids.project} value={projectId} onChange={(e) => reset(setProjectId)(e.target.value)}>
            <option value="">All projects</option>
            {projects.data?.data.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.source} className="text-xs font-medium">Source</label>
          <Select id={ids.source} value={source} onChange={(e) => reset(setSource)(e.target.value as typeof source)}>
            <option value="">Any</option><option value="auto">Auto</option><option value="manual">Manual</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.override} className="text-xs font-medium">Override</label>
          <Select id={ids.override} value={override} onChange={(e) => reset(setOverride)(e.target.value as typeof override)}>
            <option value="">Any</option><option value="true">Overrides only</option><option value="false">No override</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.sort} className="text-xs font-medium">Sort</label>
          <Select id={ids.sort} value={sort} onChange={(e) => reset(setSort)(e.target.value)}>
            <option value="project_title">Project</option><option value="trainee_name">Trainee</option><option value="-match_score">Match score (high first)</option>
          </Select>
        </div>
      </div>
      {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={() => void list.refetch()} /> : !list.data?.data.length ? (
        <EmptyState title={params.q || projectId || source || override ? "No allocations match these filters" : "No allocations yet"}
          description={cycle.status === "draft" ? "Run Auto-allocate or allocate trainees manually." : undefined} />
      ) : (
        <>
          <DataTable rows={list.data.data} columns={cols} rowKey={(a) => a.id} sort={sort} onSortChange={reset(setSort)} caption="Allocations" />
          <Pagination meta={list.data.meta} onPageChange={setPage} />
        </>
      )}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} danger loading={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)} title="Remove allocation?" confirmLabel="Remove"
        message={removing && <p>{removing.trainee.full_name} will no longer be allocated to {removing.project.title}. This is blocked once the trainee has submitted work.</p>} />
    </Card>
  );
}

