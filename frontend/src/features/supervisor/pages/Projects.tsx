import { FolderSimple, MagnifyingGlass } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { EmptyState, ErrorState, LoadingState, PageHeader, Pagination } from "@/components/shared";
import { Button, Input, Select } from "@/components/ui";

import { compact, FilterBar, SupervisorProjectCard, useDebounced, useParamState } from "../common";

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
  const total = projects.data?.meta.total;

  return (
    <>
      <PageHeader
        title="My projects"
        description={<>Projects you supervise in the active cycle{total != null && <> · <span className="tabular-nums">{total}</span> in total</>}.</>}
      />
      <FilterBar className="sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <div className="relative">
          <MagnifyingGlass aria-hidden size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle" />
          <Input aria-label="Search projects" placeholder="Search by title or code" className="pl-9" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} />
        </div>
        <Select aria-label="Status" value={status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">All statuses</option>
          <option value="draft">Draft</option>
          <option value="published">Published</option>
          <option value="archived">Archived</option>
        </Select>
        <Select aria-label="Sort" value={sort} onChange={(e) => set({ sort: e.target.value })}>
          {SORTS.map(([v, l]) => <option key={v} value={v}>Sort: {l}</option>)}
        </Select>
      </FilterBar>
      {projects.isLoading ? <LoadingState /> : projects.error ? (
        <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
      ) : !list.length ? (
        filtered ? (
          <EmptyState icon={<MagnifyingGlass />} title="No projects match these filters"
            action={<Button variant="secondary" onClick={() => { setQ(""); set({ q: null, status: null }); }}>Clear filters</Button>} />
        ) : <EmptyState icon={<FolderSimple />} title="No projects are assigned to you in this cycle." />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((p) => <SupervisorProjectCard key={p.id} project={p} />)}
          </div>
          <Pagination meta={projects.data?.meta} onPageChange={(n) => set({ page: String(n) }, false)} />
        </>
      )}
    </>
  );
}
