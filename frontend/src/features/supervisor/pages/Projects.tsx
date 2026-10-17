import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { EmptyState, ErrorState, LoadingState, PageHeader, Pagination, StatusBadge } from "@/components/shared";
import { Button, Input, Select } from "@/components/ui";
import { ProjectCard } from "@/features/shared/views";

import { compact, useDebounced, useParamState } from "../common";

const SORTS = [["title", "Title"], ["project_code", "Project code"]] as const;

export function ProjectsPage() {
  const { get, set, page } = useParamState();
  const [q, setQ] = useState(get("q"));
  const dq = useDebounced(q.trim());
  useEffect(() => {
    if (dq !== get("q")) set({ q: dq });
  }, [dq, get, set]);

  const status = (["draft", "published", "archived"] as const).find((v) => v === get("status")) ?? "";
  const sort = SORTS.some(([s]) => s === get("sort")) ? get("sort") : "title";
  const query = { mine: true, sort, page, page_size: 20, ...compact({ q: get("q"), status: status || undefined }) };
  const projects = useQuery({
    queryKey: qk.projects.list(query),
    queryFn: () => call(api.GET("/api/v1/projects", { params: { query } })),
    placeholderData: keepPreviousData,
  });
  const filtered = Boolean(get("q") || status);
  const list = projects.data?.data ?? [];

  return (
    <>
      <PageHeader title="My projects" description="Projects you supervise in the active cycle." />
      <div className="mb-4 grid gap-2 sm:grid-cols-[1fr_auto_auto]">
        <Input aria-label="Search projects" placeholder="Search by title or code" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} />
        <Select aria-label="Status" value={status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </Select>
        <Select aria-label="Sort" value={sort} onChange={(e) => set({ sort: e.target.value })}>
          {SORTS.map(([v, l]) => <option key={v} value={v}>Sort: {l}</option>)}
        </Select>
      </div>
      {projects.isLoading ? <LoadingState /> : projects.error ? (
        <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
      ) : !list.length ? (
        filtered ? (
          <EmptyState title="No projects match these filters" action={<Button variant="secondary" onClick={() => { setQ(""); set({ q: null, status: null }); }}>Clear filters</Button>} />
        ) : <EmptyState title="No projects are assigned to you in this cycle." />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((p) => (
              <div key={p.id} className="flex flex-col gap-1">
                <ProjectCard project={p} to={`/supervisor/projects/${p.id}`} badge={<StatusBadge kind="project" value={p.status} />} />
                <p className="px-1 text-xs text-muted">
                  Capacity {p.max_trainees} · Allocated {p.stats?.allocated_count ?? "—"}
                  {p.stats?.eligible_trainee_count != null && ` · Eligible ${p.stats.eligible_trainee_count}`}
                </p>
              </div>
            ))}
          </div>
          <Pagination meta={projects.data?.meta} onPageChange={(n) => set({ page: String(n) }, false)} />
        </>
      )}
    </>
  );
}
