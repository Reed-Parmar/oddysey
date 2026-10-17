/** Supervisor-module helpers shared by its pages. */
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Cycle } from "@/api/types";
import { EmptyState } from "@/components/shared";
import { Select } from "@/components/ui";
import { useCurrentCycle } from "@/app/AppShell";
import { label } from "@/lib/statusLabels";

/** Supervisors see trainees/allocations/submissions only once the cycle is published or archived. */
export const isVisibleCycle = (c: Cycle | null | undefined) => c?.status === "published" || c?.status === "archived";

export function useCycleState() {
  const q = useCurrentCycle();
  const cycle = q.data?.data ?? null;
  return { ...q, cycle, visible: isVisibleCycle(cycle) };
}

export function NotPublishedState({ cycle }: { cycle: Cycle | null }) {
  if (!cycle) return <NoCycleState />;
  return (
    <EmptyState
      title="Allocations are not published yet"
      description={`The cycle "${cycle.name}" is in ${label("cycle", cycle.status)[0].toLowerCase()}. Trainees, submissions and progress appear here once the programme team publishes allocations.`}
    />
  );
}

export function NoCycleState() {
  return <EmptyState title="There is no active cycle yet" description="The programme team will set one up." />;
}

const MY_PROJECTS_PARAMS = { mine: true, sort: "title", page_size: 100 } as const;

/** Own projects (PRJ-01 mine=true), first 100 — used for filter dropdowns and the dashboard. */
export function useMyProjects() {
  return useQuery({
    queryKey: qk.projects.list(MY_PROJECTS_PARAMS),
    queryFn: () => call(api.GET("/api/v1/projects", { params: { query: MY_PROJECTS_PARAMS } })),
  });
}

export function ProjectFilter({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  const projects = useMyProjects();
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={projects.isLoading}>
      <option value="">All my projects</option>
      {(projects.data?.data ?? []).map((p) => (
        <option key={p.id} value={p.id}>{p.project_code} · {p.title}</option>
      ))}
    </Select>
  );
}

/** URL search-param backed filter state (supervisor.md §3: filters live in the URL). Changing a filter resets `page`. */
export function useParamState() {
  const [params, setParams] = useSearchParams();
  const get = useCallback((key: string, fallback = "") => params.get(key) ?? fallback, [params]);
  const set = useCallback(
    (updates: Record<string, string | null>, resetPage = true) => {
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(updates)) {
          if (v === null || v === "") next.delete(k);
          else next.set(k, v);
        }
        if (resetPage && !("page" in updates)) next.delete("page");
        return next;
      }, { replace: true });
    },
    [setParams],
  );
  const page = Math.max(1, Number(params.get("page")) || 1);
  return { get, set, page, params };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Drops empty-string / undefined entries so query keys and query strings only carry real filters. */
export function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v !== undefined && v !== null)) as Partial<T>;
}
