import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { ProgressRow } from "@/api/types";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/shared";
import { Button, Input, Select } from "@/components/ui";
import { ProgressTable } from "@/features/shared/views";
import { LABELS } from "@/lib/statusLabels";

import { compact, NotPublishedState, ProjectFilter, useCycleState, useDebounced, useParamState } from "../common";

type Progress = ProgressRow["progress"];
const PROGRESS_VALUES = Object.keys(LABELS.progress).filter((p) => p !== "unallocated") as Progress[];
const SORTS = ["trainee_name", "project_title", "-match_score", "-total_score"];

export function ProgressPage() {
  const { get, set, page } = useParamState();
  const cycleState = useCycleState();
  const [q, setQ] = useState(get("q"));
  const dq = useDebounced(q.trim());
  useEffect(() => {
    if (dq !== get("q")) set({ q: dq });
  }, [dq, get, set]);

  const projectId = get("project_id");
  const progress = PROGRESS_VALUES.includes(get("progress") as Progress) ? (get("progress") as Progress) : "";
  const lateOnly = get("late_only") === "true";
  const sort = SORTS.includes(get("sort")) ? get("sort") : "trainee_name";
  const query = {
    sort, page, page_size: 20,
    ...compact({ project_id: projectId, progress: progress || undefined, q: get("q"), late_only: lateOnly ? true : undefined }),
  };
  const rows = useQuery({
    queryKey: qk.progress.list(query),
    queryFn: () => call(api.GET("/api/v1/progress", { params: { query } })),
    enabled: cycleState.visible,
    placeholderData: keepPreviousData,
  });
  const filtered = Boolean(projectId || progress || lateOnly || get("q"));

  return (
    <>
      <PageHeader title="Progress" description="Where each trainee on your projects stands." />
      <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-[2fr_2fr_1.5fr_auto]">
        <Input aria-label="Search trainees" placeholder="Search by trainee name or code" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} />
        <ProjectFilter id="prog-project" value={projectId} onChange={(v) => set({ project_id: v })} />
        <Select aria-label="Progress" value={progress} onChange={(e) => set({ progress: e.target.value })}>
          <option value="">All statuses</option>
          {PROGRESS_VALUES.map((p) => <option key={p} value={p}>{LABELS.progress[p][0]}</option>)}
        </Select>
        <label className="flex min-h-10 items-center gap-2 text-sm whitespace-nowrap">
          <input type="checkbox" checked={lateOnly} onChange={(e) => set({ late_only: e.target.checked ? "true" : null })} /> Late only
        </label>
      </div>
      {cycleState.isLoading ? <LoadingState /> : cycleState.error ? (
        <ErrorState error={cycleState.error} onRetry={() => void cycleState.refetch()} />
      ) : !cycleState.visible ? (
        <NotPublishedState cycle={cycleState.cycle} />
      ) : (
        <ProgressTable
          rows={rows.data?.data ?? []} meta={rows.data?.meta} isLoading={rows.isLoading} error={rows.error}
          onRetry={() => void rows.refetch()} sort={sort} onSortChange={(s) => set({ sort: s })}
          onPageChange={(n) => set({ page: String(n) }, false)}
          showTraineeColumn showSupervisorColumn={false} getRowHref={(r) => `/supervisor/trainees/${r.trainee.id}`}
          emptyState={filtered ? (
            <EmptyState title="No trainees match these filters."
              action={<Button variant="secondary" onClick={() => { setQ(""); set({ project_id: null, progress: null, late_only: null, q: null }); }}>Clear filters</Button>} />
          ) : <EmptyState title="No trainees are allocated to your projects." />}
        />
      )}
    </>
  );
}
