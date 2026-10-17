/** Student-module queries. Keys come only from `qk` (api.md C-6). */
import { useQuery } from "@tanstack/react-query";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { useCurrentCycle } from "@/app/AppShell";
import { useMyTrainee } from "@/auth/guards";

/** StudentGate has already loaded both; these read the cache. */
export function useStudentContext() {
  const cycleQ = useCurrentCycle();
  const meQ = useMyTrainee();
  return { cycle: cycleQ.data?.data ?? null, me: meQ.data?.data ?? null, cycleQ, meQ };
}

/** REC-03: the server forces own trainee, eligible, rank ≤ 5, latest completed run (C-19). */
const REC_PARAMS = { page_size: 5 } as const;
export function useMyRecommendations() {
  return useQuery({
    queryKey: qk.recommendations.list(REC_PARAMS),
    queryFn: () => call(api.GET("/api/v1/recommendations", { params: { query: REC_PARAMS } })),
  });
}

/** SUB-02: every own version in the active cycle, newest first. */
const HISTORY_PARAMS = { latest_only: false, sort: "-submitted_at", page_size: 50 } as const;
export function useMySubmissionHistory(enabled = true) {
  return useQuery({
    queryKey: qk.submissions.list(HISTORY_PARAMS),
    queryFn: () => call(api.GET("/api/v1/submissions", { params: { query: HISTORY_PARAMS } })),
    enabled,
  });
}

/** PROG-01: scope forced to the own row. */
export function useMyProgress(enabled = true) {
  return useQuery({
    queryKey: qk.progress.list({ scope: "own" }),
    queryFn: () => call(api.GET("/api/v1/progress")),
    enabled,
  });
}
