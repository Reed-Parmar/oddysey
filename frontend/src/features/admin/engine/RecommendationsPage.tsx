import {
  ArrowSquareOut, ArrowsClockwise, Cpu, Funnel, Kanban, Lightning, Ranking, Sparkle, UsersThree, WarningCircle,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Cycle, Recommendation } from "@/api/types";
import {
  Avatar, DateTime, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, StatusBadge, useToast,
} from "@/components/shared";
import { Alert, Button, Card, Select, cx } from "@/components/ui";

import { CycleLine, MiniStat, Reason, RecommendationItem, WithCycle } from "./common";
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
      <PageHeader title="Recommendations" description={<CycleLine cycle={cycle} />} />
      <div className="flex flex-col gap-6">
        <RunPanel cycle={cycle} latest={latest} start={start} />
        {completed.isLoading ? <LoadingState /> : completed.error ? (
          <ErrorState error={completed.error} onRetry={() => void completed.refetch()} />
        ) : completed.data?.data ? (
          <Results cycleId={cycle.id} runFinishedAt={completed.data.data.finished_at} />
        ) : (
          <EmptyState icon={<Ranking />} title="No recommendations yet"
            description={cycle.status !== "archived" && !isActiveRun(latest.data?.data?.status)
              ? "Run recommendations with “Generate recommendations” above to score every assessed trainee against every published project."
              : "No completed run yet for this cycle."} />
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


type Run = NonNullable<NonNullable<ReturnType<typeof useLatestRun>["data"]>["data"]>;

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
    <Card title="Recommendation run" icon={<Lightning />}
      description="Rule score from itemised factors (practical readiness 35, skills 30, career interest 20, theory and safety 15), optionally refined and explained by AI."
      actions={run && <StatusBadge kind="run" value={run.status} />}>
      {latest.isLoading ? <LoadingState label="Loading the latest run…" /> : latest.error ? (
        <ErrorState error={latest.error} onRetry={() => void latest.refetch()} />
      ) : (
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-4 rounded-lg border border-border bg-surface-2 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-col gap-1">
              <label htmlFor={toggleId} className={cx("flex items-center gap-2.5 text-sm font-medium", !aiConfigured || disabledReason ? "text-muted" : "text-text")}>
                <input id={toggleId} type="checkbox" className="size-4 accent-accent" checked={aiConfigured && useAi}
                  disabled={!aiConfigured || !!disabledReason} onChange={(e) => setUseAi(e.target.checked)} />
                <Sparkle aria-hidden size={16} weight="fill" className={aiConfigured ? "text-accent" : "text-subtle"} />
                Use AI (Groq) refinement
              </label>
              {aiConfigured
                ? <Reason>AI refines the factor detail and writes a short explanation; the rule score is the fallback.</Reason>
                : <Reason>AI is not configured on the server; runs are rule-based.</Reason>}
            </div>
            <div className="flex flex-col gap-1 sm:items-end">
              <Button size="lg" loading={start.isPending} disabled={!!disabledReason} aria-describedby={disabledReason ? reasonId : undefined}
                icon={run ? <ArrowsClockwise weight="bold" /> : <Lightning weight="fill" />}
                onClick={() => start.mutate(aiConfigured && useAi)}>
                {run ? "Re-run recommendations" : "Generate recommendations"}
              </Button>
              <Reason id={reasonId}>{disabledReason}</Reason>
            </div>
          </div>
          {publishedCount === 0 && (
            <Alert variant="warning" icon={<WarningCircle />}>
              No published projects; the run will score nothing. <Link className="font-semibold underline" to="/admin/projects">Publish projects</Link>
            </Alert>
          )}
          {start.stateError != null && (
            <Alert variant="danger" icon={<WarningCircle />} title="Cannot start a run">
              <ul className="list-disc pl-5">{detailMessages(start.stateError).map((m) => <li key={m}>{m}</li>)}</ul>
            </Alert>
          )}
          {run ? <RunStatus run={run} /> : <p className="text-sm text-muted">No run yet for this cycle.</p>}
        </div>
      )}
    </Card>
  );
}

/** AI vs rule-only indicator for a run. */
function AiMode({ run }: { run: Run }) {
  if (!run.use_ai) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-neutral-bg px-2.5 py-0.5 text-xs font-semibold text-neutral">
        <Cpu aria-hidden size={14} /> Rule-based only
      </span>
    );
  }
  const allFellBack = run.status === "completed" && run.ai_used_count === 0;
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent-soft px-2.5 py-0.5 text-xs font-semibold text-accent-ink">
        <Sparkle aria-hidden size={14} weight="fill" className="text-accent" /> AI-assisted{run.ai_model ? ` · ${run.ai_model}` : ""}
      </span>
      {(allFellBack || run.ai_failed_count > 0) && (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-warning/25 bg-warning-bg px-2.5 py-0.5 text-xs font-semibold text-warning">
          <Cpu aria-hidden size={14} />
          {allFellBack ? "AI unavailable: rule-only fallback used" : `Rule-only fallback for ${run.ai_failed_count}`}
        </span>
      )}
    </span>
  );
}

function RunStatus({ run }: { run: Run }) {
  const p = runProgress(run);
  const running = isActiveRun(run.status);
  return (
    <div className="flex flex-col gap-4">
      <div aria-live="polite">
        <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2 text-sm">
          <span className="font-medium text-text">
            {running ? "Scoring trainees…" : run.status === "completed" ? "Run complete" : "Run stopped"}
          </span>
          <span className="text-muted tabular-nums">{p.done} / {p.total} trainees · {p.pct}%</span>
        </div>
        <div className="h-2.5 w-full overflow-hidden rounded-full bg-neutral-bg" role="progressbar" aria-valuemin={0}
          aria-valuemax={100} aria-valuenow={p.pct} aria-label="Recommendation run progress">
          <div className={cx("h-full rounded-full transition-[width] duration-500",
            run.status === "failed" ? "bg-danger" : run.status === "completed" ? "bg-success" : "bg-primary",
            running && "animate-pulse")} style={{ width: `${p.pct}%` }} />
        </div>
      </div>
      {run.status === "failed" && (
        <Alert variant="danger" icon={<WarningCircle />} title="The run failed">{run.error_message ?? "Unknown error"}. Re-run to try again.</Alert>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-muted">Scoring mode</span>
        <AiMode run={run} />
      </div>
      <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MiniStat label="Trainees" value={run.trainee_count} />
        <MiniStat label="Skipped (assessment pending)" value={run.skipped_pending_count} tone={run.skipped_pending_count > 0 ? "warning" : undefined} />
        <MiniStat label="Scored pairs" value={run.scored_pairs} />
        {run.use_ai ? (
          <MiniStat tone="accent" label={`AI used / failed (${run.ai_model ?? "Groq"})`} value={`${run.ai_used_count} / ${run.ai_failed_count}`} />
        ) : <MiniStat label="AI" value="Rule-based only" />}
      </dl>
      <p className="text-xs text-muted">
        Started by {run.started_by.full_name} · <DateTime value={run.started_at ?? run.created_at} />
        {run.finished_at && <> · finished <DateTime value={run.finished_at} /></>}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------- results

type View = "trainee" | "project";

/** Splits a page of rows into consecutive groups (rows arrive sorted by the grouping key). */
function groupBy(rows: Recommendation[], key: (r: Recommendation) => string) {
  const groups: { key: string; rows: Recommendation[] }[] = [];
  for (const r of rows) {
    const k = key(r);
    const last = groups[groups.length - 1];
    if (last && last.key === k) last.rows.push(r);
    else groups.push({ key: k, rows: [r] });
  }
  return groups;
}

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
  const rows = recs.data?.data ?? [];

  return (
    <Card title="Results" icon={<Ranking />}
      description={runFinishedAt ? <>Latest completed run · <DateTime value={runFinishedAt} /></> : undefined}>
      <div className="mb-5 flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div role="tablist" aria-label="Recommendation view" className="inline-flex w-full rounded-lg border border-border bg-surface-2 p-1 sm:w-auto">
          {(["trainee", "project"] as const).map((v) => (
            <button key={v} type="button" role="tab" aria-selected={view === v}
              className={cx("inline-flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition-colors duration-150 sm:flex-none",
                view === v ? "bg-surface text-primary shadow-card" : "text-muted hover:text-text")}
              onClick={() => switchView(v)}>
              {v === "trainee" ? <UsersThree aria-hidden size={16} /> : <Kanban aria-hidden size={16} />}
              {v === "trainee" ? "By trainee" : "By project"}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 sm:w-80 sm:flex-none">
            <label htmlFor={pickerId} className="text-sm font-semibold">{view === "trainee" ? "Trainee" : "Project"}</label>
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
          <label htmlFor={eligibleId} className="flex min-h-10 items-center gap-2 text-sm font-medium">
            <input id={eligibleId} type="checkbox" className="size-4 accent-primary" checked={eligibleOnly}
              onChange={(e) => { setEligibleOnly(e.target.checked); setPage(1); }} />
            Eligible only
          </label>
        </div>
      </div>
      {selected && (
        <p className="mb-4 text-sm">
          <Link className="inline-flex items-center gap-1 font-semibold text-primary hover:underline"
            to={view === "trainee" ? `/admin/trainees/${traineeId}` : `/admin/projects/${projectId}`}>
            {view === "trainee" ? "Open trainee profile" : "Open project"} <ArrowSquareOut aria-hidden size={14} />
          </Link>
        </p>
      )}
      {recs.isLoading ? <LoadingState /> : recs.error ? <ErrorState error={recs.error} onRetry={() => void recs.refetch()} /> : !rows.length ? (
        <EmptyState icon={<Funnel />} title="No recommendations match"
          description={eligibleOnly ? "Turn off “Eligible only” to see ineligible pairs and their reasons." : "Nothing was scored for this selection."} />
      ) : (
        <>
          {view === "trainee" ? (
            <div className="flex flex-col gap-5">
              {groupBy(rows, (r) => r.trainee.id).map((g) => <TraineeGroup key={g.key} rows={g.rows} />)}
            </div>
          ) : (
            <div className="flex flex-col gap-2.5">
              {rows.map((r) => <RecommendationItem key={r.id} recommendation={r} perspective="project" />)}
            </div>
          )}
          <Pagination meta={recs.data?.meta} onPageChange={setPage} />
        </>
      )}
    </Card>
  );
}

function TraineeGroup({ rows }: { rows: Recommendation[] }) {
  const t = rows[0]!.trainee;
  const eligible = rows.filter((r) => r.eligible).length;
  return (
    <section aria-label={`Recommendations for ${t.full_name}`} className="rounded-xl border border-border bg-surface-2 p-3 sm:p-4">
      <header className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Avatar name={t.full_name} />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-text">
              <Link className="hover:text-primary hover:underline" to={`/admin/trainees/${t.id}`}>{t.full_name}</Link>
            </h3>
            <p className="text-xs text-muted">{t.trainee_code}</p>
          </div>
        </div>
        <span className="text-xs text-muted tabular-nums">{eligible} of {rows.length} eligible</span>
      </header>
      <div className="flex flex-col gap-2.5">
        {rows.map((r) => <RecommendationItem key={r.id} recommendation={r} perspective="trainee" />)}
      </div>
    </section>
  );
}
