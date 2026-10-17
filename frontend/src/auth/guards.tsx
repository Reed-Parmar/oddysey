import { CalendarBlank, LinkBreak } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { UserRole } from "@/api/types";
import { HOME } from "@/app/nav";
import { useCurrentCycle } from "@/app/AppShell";
import { EmptyState, ErrorState, Forbidden, LoadingState } from "@/components/shared";

import { useAuth } from "./AuthProvider";

function FullPageLoader({ label }: { label: string }) {
  return (
    <div role="status" className="flex min-h-dvh flex-col items-center justify-center gap-4 text-sm font-medium text-muted">
      <span aria-hidden className="size-8 animate-spin rounded-full border-[3px] border-primary/20 border-t-primary" />
      {label}
    </div>
  );
}

/** UX only: the API enforces every permission (auth.md §1.4). */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const loc = useLocation();
  if (state.status === "loading" || state.status === "provisioning") return <FullPageLoader label={state.status === "provisioning" ? "Setting up your account…" : "Signing you in…"} />;
  if (state.status === "error") return <div className="mx-auto max-w-lg p-6 pt-20"><ErrorState error={new Error(state.message)} onRetry={() => location.reload()} /></div>;
  if (state.status === "signedOut") return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

export function RequireRole({ role }: { role: UserRole }) {
  const { user } = useAuth();
  if (!user) return null;
  if (user.role !== role) return <Forbidden />;
  return <Outlet />;
}

export function RoleRedirect() {
  const { user } = useAuth();
  return user ? <Navigate to={HOME[user.role]} replace /> : null;
}

export function useMyTrainee() {
  return useQuery({ queryKey: qk.trainees.me(), queryFn: () => call(api.GET("/api/v1/trainees/me")) });
}

/** Students need an active cycle and a linked trainee record (api.md C-9; TRN-08 is past the 48 h cut line). */
export function StudentGate() {
  const cycle = useCurrentCycle();
  const me = useMyTrainee();
  if (cycle.isLoading || me.isLoading) return <LoadingState />;
  if (cycle.error) return <ErrorState error={cycle.error} onRetry={() => cycle.refetch()} />;
  if (!cycle.data?.data)
    return <EmptyState icon={<CalendarBlank />} title="No active programme cycle" description="Your programme team has not opened a project cycle yet. Check back later." />;
  if (me.error) return <ErrorState error={me.error} onRetry={() => me.refetch()} />;
  if (!me.data?.data)
    return (
      <EmptyState
        icon={<LinkBreak />}
        title="Your trainee record is not linked yet"
        description="Ask your programme coordinator to send you an invitation linked to your trainee record, then register using that link."
      />
    );
  return <Outlet />;
}
