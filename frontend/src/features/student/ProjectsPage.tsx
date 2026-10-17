import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Project } from "@/api/types";
import { EmptyState, ErrorState, LoadingState, PageHeader, Pagination, StatusBadge } from "@/components/shared";
import { Button, Input, Select } from "@/components/ui";
import { formatScore } from "@/lib/format";
import { ProjectCard, ProjectDetailView, RecommendationCard } from "@/features/shared/views";

import { useMyRecommendations, useStudentContext } from "./hooks";

const DIFFICULTIES: Project["difficulty"][] = ["beginner", "intermediate", "advanced"];
const PAGE_SIZE = 20;

export function ProjectsPage() {
  const { cycle, me } = useStudentContext();
  const [sp, setSp] = useSearchParams();
  const urlQ = sp.get("q") ?? "";
  const [qInput, setQInput] = useState(urlQ);
  const difficulty = DIFFICULTIES.find((d) => d === sp.get("difficulty"));
  const allTrades = sp.get("trade") === "all";
  const page = Math.max(1, Number(sp.get("page")) || 1);
  const recs = useMyRecommendations();

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    if (!("page" in patch)) next.delete("page");
    setSp(next, { replace: true });
  };

  // Debounce the search box into the URL (300 ms).
  useEffect(() => {
    const t = setTimeout(() => {
      if (qInput.trim() !== urlQ.trim()) {
        const next = new URLSearchParams(sp);
        if (qInput.trim()) next.set("q", qInput);
        else next.delete("q");
        next.delete("page");
        setSp(next, { replace: true });
      }
    }, 300);
    return () => clearTimeout(t);
  }, [qInput, urlQ, sp, setSp]);

  const q = urlQ.trim();
  const params = {
    q: q || undefined,
    difficulty,
    trade_id: allTrades ? undefined : me?.trade.id,
    sort: "title",
    page,
    page_size: PAGE_SIZE,
  };
  const projects = useQuery({
    queryKey: qk.projects.list(params),
    queryFn: () => call(api.GET("/api/v1/projects", { params: { query: params } })),
    enabled: !!me,
    placeholderData: keepPreviousData,
  });

  const recByProject = new Map((recs.data?.data ?? []).map((r) => [r.project.id, r]));
  const qError = projects.error instanceof ApiError && projects.error.status === 422 ? errorMessage(projects.error) : null;
  const filtered = !!q || !!difficulty;

  let body;
  if (!cycle) body = <EmptyState title="No active cycle" />;
  else if (projects.isLoading || !me) body = <LoadingState label="Loading projects…" />;
  else if (projects.error && !qError) body = <ErrorState error={projects.error} onRetry={() => projects.refetch()} />;
  else if (!projects.data?.data.length)
    body = !allTrades ? (
      <EmptyState
        title={filtered ? "No projects match your filters for your trade" : "No published projects for your trade yet."}
        action={<Button variant="secondary" onClick={() => update({ trade: "all" })}>Show all trades</Button>}
      />
    ) : (
      <EmptyState title={filtered ? "No projects match your filters" : "No projects are published yet."} />
    );
  else
    body = (
      <>
        <ul className={`grid gap-3 sm:grid-cols-2 lg:grid-cols-3 ${projects.isFetching ? "opacity-70" : ""}`}>
          {projects.data.data.map((p) => {
            const r = recByProject.get(p.id);
            return (
              <li key={p.id}>
                <ProjectCard
                  project={p}
                  to={`/student/projects/${p.id}`}
                  badge={r ? <span className="rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium whitespace-nowrap text-success">Suggested · {formatScore(r.score)}</span> : undefined}
                />
              </li>
            );
          })}
        </ul>
        <Pagination meta={projects.data.meta} onPageChange={(p) => update({ page: String(p) })} />
      </>
    );

  return (
    <div>
      <PageHeader title="Project catalogue" description="Published projects in the current programme cycle." />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start">
        <div className="sm:w-72">
          <label htmlFor="project-search" className="sr-only">Search projects</label>
          <Input
            id="project-search"
            type="search"
            placeholder="Search title, code or category"
            maxLength={100}
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            aria-invalid={!!qError || undefined}
          />
          {qError && <p className="mt-1 text-xs text-danger" role="alert">{qError}</p>}
        </div>
        <div className="sm:w-48">
          <label htmlFor="difficulty" className="sr-only">Difficulty</label>
          <Select id="difficulty" value={difficulty ?? ""} onChange={(e) => update({ difficulty: e.target.value || null })}>
            <option value="">Any difficulty</option>
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>{d[0].toUpperCase() + d.slice(1)}</option>
            ))}
          </Select>
        </div>
        {me && (
          <div className="flex min-h-10 items-center">
            {allTrades ? (
              <Button size="sm" variant="ghost" onClick={() => update({ trade: null })}>
                Only my trade ({me.trade.name})
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-1 pr-1 pl-3 text-sm text-primary">
                My trade: {me.trade.name}
                <button type="button" className="rounded-full px-1.5 hover:bg-primary/20" aria-label="Remove trade filter" onClick={() => update({ trade: "all" })}>
                  ×
                </button>
              </span>
            )}
          </div>
        )}
      </div>
      {body}
    </div>
  );
}

export function ProjectDetailPage() {
  const { projectId = "" } = useParams();
  const { me } = useStudentContext();
  const recs = useMyRecommendations();
  const project = useQuery({
    queryKey: qk.projects.detail(projectId),
    queryFn: () => call(api.GET("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId } } })),
    enabled: !!projectId,
  });

  if (project.isLoading) return <LoadingState />;
  if (project.error || !project.data) return <ErrorState error={project.error} onRetry={() => project.refetch()} />;
  const p = project.data.data;
  const rec = recs.data?.data.find((r) => r.project.id === p.id);
  const isMine = me?.allocation?.project.id === p.id;

  return (
    <div>
      <PageHeader
        title={p.title}
        description={p.project_code}
        actions={<Link className="text-sm text-primary underline" to="/student/projects">Back to catalogue</Link>}
      />
      <div className="flex flex-col gap-4">
        {isMine && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-success/40 bg-success-bg p-3 text-sm text-success">
            <StatusBadge kind="progress" value="allocated" />
            <span className="font-medium">Your allocated project</span>
            <Link className="underline" to="/student/submission">Go to My project & submission</Link>
          </div>
        )}
        <ProjectDetailView project={p} />
        {rec && (
          <section aria-label="Your match for this project">
            <h2 className="mb-2 text-base font-semibold">Why it was suggested to you</h2>
            <RecommendationCard recommendation={rec} compact perspective="trainee" />
          </section>
        )}
      </div>
    </div>
  );
}
