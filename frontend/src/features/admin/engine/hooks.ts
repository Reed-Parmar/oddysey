import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";

import { isActiveRun, runJustFinished } from "./lib";

/** REC-02 latest run, polled every 2 s while queued/running (admin.md §12.3). Invalidates once on finish. */
export function useLatestRun(cycleId: string | undefined) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: qk.recommendationRuns.latest(cycleId ?? ""),
    queryFn: () => call(api.GET("/api/v1/cycles/{cycle_id}/recommendation-runs/latest", { params: { path: { cycle_id: cycleId! } } })),
    enabled: !!cycleId,
    refetchInterval: (query) => (isActiveRun(query.state.data?.data?.status) ? 2000 : false),
  });
  const loaded = q.data !== undefined;
  const status = q.data?.data?.status;
  const runId = q.data?.data?.id;
  const prev = useRef<{ id?: string; status?: string } | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const next = { id: runId, status };
    if (cycleId && runJustFinished(prev.current, next)) {
      void qc.invalidateQueries({ queryKey: qk.recommendations.all() });
      void qc.invalidateQueries({ queryKey: qk.recommendationRuns.latest(cycleId, "completed") });
      void qc.invalidateQueries({ queryKey: qk.projects.all() });
      void qc.invalidateQueries({ queryKey: qk.reports.all() });
    }
    prev.current = next;
  }, [loaded, status, runId, cycleId, qc]);
  return q;
}

/** REC-02 `?status=completed`: the latest completed run, or null (C-18). */
export function useCompletedRun(cycleId: string | undefined) {
  return useQuery({
    queryKey: qk.recommendationRuns.latest(cycleId ?? "", "completed"),
    queryFn: () => call(api.GET("/api/v1/cycles/{cycle_id}/recommendation-runs/latest", {
      params: { path: { cycle_id: cycleId! }, query: { status: "completed" } },
    })),
    enabled: !!cycleId,
  });
}

/** Published projects of the cycle with stats (capacity usage, pickers). */
export function usePublishedProjects(cycleId: string | undefined) {
  const params = { cycle_id: cycleId, status: "published" as const, sort: "title", page_size: 100 };
  return useQuery({
    queryKey: qk.projects.list(params),
    queryFn: () => call(api.GET("/api/v1/projects", { params: { query: params } })),
    enabled: !!cycleId,
  });
}

/** Invalidations after ALLOC-02/03/04/05 (admin.md §12.2). */
export function invalidateAllocationWrites(qc: QueryClient) {
  for (const key of [qk.allocations.all(), qk.progress.all(), qk.trainees.all(), qk.projects.all(), qk.reports.all()]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

/** Invalidations after CYC-06 (admin.md §12.2). */
export function invalidateCycleTransition(qc: QueryClient) {
  for (const key of [qk.cycles.all(), qk.allocations.all(), qk.progress.all(), qk.trainees.all(), qk.projects.all(),
    qk.submissions.all(), qk.reports.all()]) {
    void qc.invalidateQueries({ queryKey: key });
  }
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
