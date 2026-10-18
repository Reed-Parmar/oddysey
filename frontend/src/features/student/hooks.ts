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

/** SUB-02: every own version in the active cycle, newest first. */
const HISTORY_PARAMS = { latest_only: false, sort: "-submitted_at", page_size: 50 } as const;
export function useMySubmissionHistory(enabled = true) {
  return useQuery({
    queryKey: qk.submissions.list(HISTORY_PARAMS),
    queryFn: () => call(api.GET("/api/v1/submissions", { params: { query: HISTORY_PARAMS } })),
    enabled,
    refetchInterval: (q) => q.state.data?.data.some((s) => s.status === "submitted") ? 4000 : false,
  });
}

/** RES-02: latest resume of the own active-cycle trainee record (null when none). */
export function useMyResume() {
  return useQuery({
    queryKey: qk.resumes.me(),
    queryFn: () => call(api.GET("/api/v1/trainees/me/resumes/latest")),
  });
}

/** Own allocations in every cycle (active, rejected, archived). Read-only. */
export function useMyAllocationHistory() {
  return useQuery({
    queryKey: qk.allocationHistory.me(),
    queryFn: () => call(api.GET("/api/v1/trainees/me/allocation-history")),
  });
}

/** In-app notifications (newest first). */
export function useMyNotifications() {
  return useQuery({
    queryKey: qk.notifications.me(),
    queryFn: () => call(api.GET("/api/v1/me/notifications")),
  });
}

export function useTrades() {
  return useQuery({
    queryKey: qk.trades.list(),
    queryFn: () => call(api.GET("/api/v1/trades")),
    staleTime: 5 * 60_000,
  });
}

/** PRJ detail (stats are null for students). */
export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: qk.projects.detail(projectId ?? ""),
    queryFn: () => call(api.GET("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId ?? "" } } })),
    enabled: !!projectId,
  });
}

export function useOnboarding() {
  return useQuery({
    queryKey: qk.onboarding.me(),
    queryFn: () => call(api.GET("/api/v1/onboarding")),
  });
}
