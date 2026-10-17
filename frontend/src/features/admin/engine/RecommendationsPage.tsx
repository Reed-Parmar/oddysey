import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Cycle } from "@/api/types";
import {
  DateTime, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, StatusBadge, useToast,
} from "@/components/shared";
import { Alert, Button, Card, Select } from "@/components/ui";
import { RecommendationCard } from "@/features/shared/views";

import { Reason, WithCycle } from "./common";
import { useCompletedRun, useLatestRun, usePublishedProjects } from "./hooks";
import { detailMessages, isActiveRun, runProgress } from "./lib";

export function RecommendationsPage() {
  return (
    <WithCycle title="Recommendations" description="Rule-based match scores with itemised factors, optionally refined by AI.">
      {(cycle) => <RecommendationsBody cycle={cycle} />}
    </WithCycle>
  );
}

function RecommendationsBody({ cycle }: { cycle: Cycle }) {
  const latest = useLatestRun(cycle.id);
  const completed = useCompletedRun(cycle.id);
  const start = useStartRun(cycle);
  return (
    <>
      <PageHeader title="Recommendations"
        description={<>Cycle <span className="font-medium">{cycle.name}</span> <StatusBadge kind="cycle" value={cycle.status} /></>} />
      <div className="flex flex-col gap-5">
        <RunPanel cycle={cycle} latest={latest} start={start} />
        {completed.isLoading ? <LoadingState /> : completed.error ? (
          <ErrorState error={completed.error} onRetry={() => void completed.refetch()} />
        ) : completed.data?.data ? (
          <Results cycleId={cycle.id} runFinishedAt={completed.data.data.finished_at} />
        ) : (
          <EmptyState title="No recommendations yet"
            description="Generate recommendations to score every assessed trainee against every published project."
            action={cycle.status !== "archived" && !isActiveRun(latest.data?.data?.status)
              ? <Button loading={start.isPending} onClick={() => start.mutate(latest.data?.meta.ai_configured ?? false)}>Run recommendations</Button>
              : undefined} />
        )}
      </div>
    </>
  );
}

function useStartRun(cycle: Cycle) {
  const qc = useQueryClient();
  const toast = useToast();
  const [stateError, setStateError] = useState<unknown>(null);
  const m = useMutation({
    mutationFn: (useAi: boolean) => call(api.POST("/api/v1/cycles/{cycle_id}/recommendation-runs", {
      params: { path: { cycle_id: cycle.id } }, body: { use_ai: useAi },
    })),
    onMutate: () => setStateError(null),
    onSuccess: () => {
      toast.success("Recommendation run started");
      void qc.invalidateQueries({ queryKey: qk.recommendationRuns.latest(cycle.id) });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "RUN_IN_PROGRESS") {
        toast.info("A run is already in progress; showing its progress.");
        void qc.invalidateQueries({ queryKey: qk.recommendationRuns.latest(cycle.id) });
      } else if (e instanceof ApiError && e.code === "INVALID_STATE") {
        setStateError(e);
      } else {
        toast.error(errorMessage(e));
      }
    },
  });
  return { ...m, stateError };
}

function RunPanel({ cycle, latest, start }: {
  cycle: Cycle; latest: ReturnType<typeof useLatestRun>; start: ReturnType<typeof useStartRun>;
}) {
  const [useAi, setUseAi] = useState(true);
  const projects = usePublishedProjects(cycle.id);
  const toggleId = useId();
  const reasonId = useId();
  const run = latest.data?.data ?? null;
  const aiConfigured = latest.data?.meta.ai_configured ?? false;
  const active = isActiveRun(run?.status);
  const disabledReason = cycle.status === "archived" ? "Cycle is archived" : active ? "A run is in progress" : null;
  const publishedCount = projects.data?.meta.total;

  return (
    <Card title="Run" actions={run && <StatusBadge kind="run" value={run.status} />}>
      {latest.isLoading ? <LoadingState label="Loading the latest run…" /> : latest.error ? (
        <ErrorState error={latest.error} onRetry={() => void latest.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="flex flex-col gap-1">
              <label htmlFor={toggleId} className="flex items-center gap-2 text-sm">
                <input id={toggleId} type="checkbox" className="size-4" checked={aiConfigured && useAi}
                  disabled={!aiConfigured || !!disabledReason} onChange={(e) => setUseAi(e.target.checked)} />
                Use AI (Groq) refinement
              </label>
              {!aiConfigured && <Reason>AI is not configured on the server; runs are rule-based.</Reason>}
            </div>
            <div className="flex flex-col gap-1">
              <Button loading={start.isPending} disabled={!!disabledReason} aria-describedby={disabledReason ? reasonId : undefined}
                onClick={() => start.mutate(aiConfigured && useAi)}>
                {run ? "Re-run recommendations" : "Generate recommendations"}
              </Button>
              <Reason id={reasonId}>{disabledReason}</Reason>
            </div>
          </div>
          {publishedCount === 0 && (
            <Alert variant="warning">
              No published projects; the run will score nothing. <Link className="underline" to="/admin/projects">Publish projects</Link>
            </Alert>
          )}
          {start.stateError != null && (
            <Alert variant="danger" title="Cannot start a run">
              <ul className="list-disc pl-5">{detailMessages(start.stateError).map((m) => <li key={m}>{m}</li>)}</ul>
            </Alert>
          )}
          {run ? <RunStatus run={run} /> : <p className="text-sm text-muted">No run yet for this cycle.</p>}
        </div>
      )}
    </Card>
  );
}

function RunStatus({ run }: { run: NonNullable<NonNullable<ReturnType<typeof useLatestRun>["data"]>["data"]> }) {
  const p = runProgress(run);
  return (
    <div className="flex flex-col gap-3">
      <div aria-live="polite">
        <div className="mb-1 flex justify-between text-sm">
          <span>{isActiveRun(run.status) ? "Scoring trainees…" : run.status === "completed" ? "Run complete" : "Run stopped"}</span>
          <span className="tabular-nums">{p.done} / {p.total} trainees</span>
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-bg" role="progressbar" aria-valuemin={0}
          aria-valuemax={100} aria-valuenow={p.pct} aria-label="Recommendation run progress">
          <div className={`h-full rounded-full transition-all ${run.status === "failed" ? "bg-danger" : "bg-primary"}`} style={{ width: `${p.pct}%` }} />
        </div>
      </div>
      {run.status === "failed" && (
        <Alert variant="danger" title="The run failed">{run.error_message ?? "Unknown error"}. Re-run to try again.</Alert>
      )}
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label="Trainees" value={run.trainee_count} />
        <Stat label="Skipped (assessment pending)" value={run.skipped_pending_count} />
        <Stat label="Scored pairs" value={run.scored_pairs} />
        <Stat label={run.use_ai ? `AI used / failed (${run.ai_model ?? "Groq"})` : "AI"}
          value={run.use_ai ? `${run.ai_used_count} / ${run.ai_failed_count}` : "Rule-based only"} />
      </dl>
      <p className="text-xs text-muted">
        Started by {run.started_by.full_name} · <DateTime value={run.started_at ?? run.created_at} />
        {run.finished_at && <> · finished <DateTime value={run.finished_at} /></>}
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border p-2">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------- results

type View = "trainee" | "project";

function Results({ cycleId, runFinishedAt }: { cycleId: string; runFinishedAt: string | null }) {
  const [view, setView] = useState<View>("trainee");
  const [traineeId, setTraineeId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [eligibleOnly, setEligibleOnly] = useState(false);
  const [page, setPage] = useState(1);
  const pickerId = useId();
  const eligibleId = useId();

  const traineeParams = { cycle_id: cycleId, sort: "full_name", page_size: 100 };
  const trainees = useQuery({
    queryKey: qk.trainees.list(traineeParams),
    queryFn: () => call(api.GET("/api/v1/trainees", { params: { query: traineeParams } })),
    enabled: view === "trainee",
  });
  const projects = usePublishedProjects(cycleId);

  const selected = view === "trainee" ? traineeId : projectId;
  const params = {
    cycle_id: cycleId,
    ...(view === "trainee" && traineeId ? { trainee_id: traineeId } : {}),
    ...(view === "project" && projectId ? { project_id: projectId } : {}),
    eligible_only: eligibleOnly,
    sort: view === "project" ? "-score" : traineeId ? "rank" : "trainee_name",
    page,
    page_size: 20,
  };
  const recs = useQuery({
    queryKey: qk.recommendations.list(params),
    queryFn: () => call(api.GET("/api/v1/recommendations", { params: { query: params } })),
  });

  const switchView = (v: View) => { setView(v); setPage(1); };
  const perspective = view === "project" ? "project" : traineeId ? "trainee" : undefined;

  return (
    <Card title="Results" actions={runFinishedAt && <span className="text-xs text-muted">Latest completed run · <DateTime value={runFinishedAt} /></span>}>
      <div role="tablist" aria-label="Recommendation view" className="mb-4 flex gap-1 border-b border-border">
        {(["trainee", "project"] as const).map((v) => (
          <button key={v} type="button" role="tab" aria-selected={view === v}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${view === v ? "border-primary font-medium text-primary" : "border-transparent text-muted"}`}
            onClick={() => switchView(v)}>
            {v === "trainee" ? "By trainee" : "By project"}
          </button>
        ))}
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1 sm:max-w-sm">
          <label htmlFor={pickerId} className="text-sm font-medium">{view === "trainee" ? "Trainee" : "Project"}</label>
          {view === "trainee" ? (
            <Select id={pickerId} value={traineeId} onChange={(e) => { setTraineeId(e.target.value); setPage(1); }}>
              <option value="">All trainees (grouped by trainee)</option>
              {trainees.data?.data.map((t) => <option key={t.id} value={t.id}>{t.full_name} · {t.trainee_code}</option>)}
            </Select>
          ) : (
            <Select id={pickerId} value={projectId} onChange={(e) => { setProjectId(e.target.value); setPage(1); }}>
              <option value="">All projects (highest score first)</option>
              {projects.data?.data.map((p) => <option key={p.id} value={p.id}>{p.title} · {p.project_code}</option>)}
            </Select>
          )}
        </div>
        <label htmlFor={eligibleId} className="flex min-h-10 items-center gap-2 text-sm">
          <input id={eligibleId} type="checkbox" className="size-4" checked={eligibleOnly}
            onChange={(e) => { setEligibleOnly(e.target.checked); setPage(1); }} />
          Eligible only
        </label>
      </div>
      {selected && view === "trainee" && (
        <p className="mb-3 text-sm"><Link className="text-primary underline" to={`/admin/trainees/${traineeId}`}>Open trainee profile</Link></p>
      )}
      {selected && view === "project" && (
        <p className="mb-3 text-sm"><Link className="text-primary underline" to={`/admin/projects/${projectId}`}>Open project</Link></p>
      )}
      {recs.isLoading ? <LoadingState /> : recs.error ? <ErrorState error={recs.error} onRetry={() => void recs.refetch()} /> : !recs.data?.data.length ? (
        <EmptyState title="No recommendations match"
          description={eligibleOnly ? "Turn off “Eligible only” to see ineligible pairs and their reasons." : "Nothing was scored for this selection."} />
      ) : (
        <>
          <div className="flex flex-col gap-3">
            {recs.data.data.map((r) => <RecommendationCard key={r.id} recommendation={r} perspective={perspective} compact />)}
          </div>
          <Pagination meta={recs.data.meta} onPageChange={setPage} />
        </>
      )}
    </Card>
  );
}
