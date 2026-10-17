import { CheckCircle, Funnel, GraduationCap, Kanban, Lightbulb, MagnifyingGlass, Star, Users, X } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { useParams, useSearchParams, Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Project } from "@/api/types";
import { BackLink, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, StatusBadge } from "@/components/shared";
import { Button, Input, Select, cx } from "@/components/ui";
import { formatScore } from "@/lib/format";
import { ProjectDetailView } from "@/features/shared/views";

import { useMyRecommendations, useStudentContext } from "./hooks";
import { LinkButton, StudentRecommendationCard } from "./ui";

const DIFFICULTIES: Project["difficulty"][] = ["beginner", "intermediate", "advanced"];
const PAGE_SIZE = 20;

/** Catalogue tile (student view). */
function CatalogueCard({ project: p, to, badge }: { project: Project; to: string; badge?: ReactNode }) {
  return (
    <Link
      to={to}
      className="flex h-full flex-col rounded-xl border border-border bg-surface p-4 shadow-card transition-[border-color,box-shadow] duration-150 hover:border-primary/40 hover:shadow-raised sm:p-5"
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-semibold tracking-wide text-muted uppercase">{p.project_code}</p>
        {badge}
      </div>
      <h3 className="mt-1 text-base font-semibold text-text [overflow-wrap:anywhere]">{p.title}</h3>
      {p.category && <p className="mt-1 line-clamp-2 text-sm text-muted">{p.category}</p>}
      <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-2 pt-4 text-xs text-muted">
        <StatusBadge kind="difficulty" value={p.difficulty} />
        <span className="inline-flex items-center gap-1"><GraduationCap aria-hidden size={14} />{p.target_trade.name}</span>
        <span className="inline-flex items-center gap-1 tabular-nums"><Star aria-hidden size={14} />Min practical {formatScore(p.min_practical_score)}%</span>
        <span className="inline-flex items-center gap-1 tabular-nums"><Users aria-hidden size={14} />Capacity {p.max_trainees}</span>
      </div>
    </Link>
  );
}

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
        icon={<MagnifyingGlass />}
        title={filtered ? "No projects match your filters for your trade" : "No published projects for your trade yet."}
        action={<Button variant="secondary" onClick={() => update({ trade: "all" })}>Show all trades</Button>}
      />
    ) : (
      <EmptyState icon={<MagnifyingGlass />} title={filtered ? "No projects match your filters" : "No projects are published yet."} />
    );
  else
    body = (
      <>
        <ul className={cx("grid gap-4 transition-opacity duration-150 sm:grid-cols-2 lg:grid-cols-3", projects.isFetching && "opacity-70")}>
          {projects.data.data.map((p) => {
            const r = recByProject.get(p.id);
            return (
              <li key={p.id}>
                <CatalogueCard
                  project={p}
                  to={`/student/projects/${p.id}`}
                  badge={r ? (
                    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/25 bg-accent-soft px-2 py-0.5 text-xs font-semibold whitespace-nowrap text-accent-ink">
                      <Lightbulb aria-hidden size={12} weight="fill" />
                      Suggested · {formatScore(r.score)}
                    </span>
                  ) : undefined}
                />
              </li>
            );
          })}
        </ul>
        <Pagination meta={projects.data.meta} onPageChange={(p) => update({ page: String(p) })} />
      </>
    );

  return (
    <div className="space-y-6">
      <PageHeader title="Project catalogue" description="Published projects in the current programme cycle." />
      <div role="search" aria-label="Filter projects" className="flex flex-wrap items-start gap-3 rounded-xl border border-border bg-surface p-3 shadow-card sm:p-4">
        <div className="w-full sm:w-72">
          <label htmlFor="project-search" className="sr-only">Search projects</label>
          <div className="relative">
            <MagnifyingGlass aria-hidden size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle" />
            <Input
              id="project-search"
              type="search"
              placeholder="Search title, code or category"
              maxLength={100}
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              aria-invalid={!!qError || undefined}
              className="pl-9"
            />
          </div>
          {qError && <p className="mt-1 text-xs text-danger" role="alert">{qError}</p>}
        </div>
        <div className="w-full min-[480px]:w-auto min-[480px]:min-w-48">
          <label htmlFor="difficulty" className="sr-only">Difficulty</label>
          <Select id="difficulty" value={difficulty ?? ""} onChange={(e) => update({ difficulty: e.target.value || null })}>
            <option value="">Any difficulty</option>
            {DIFFICULTIES.map((d) => (
              <option key={d} value={d}>{d[0].toUpperCase() + d.slice(1)}</option>
            ))}
          </Select>
        </div>
        {me && (
          <div className="flex min-h-11 items-center sm:min-h-10">
            {allTrades ? (
              <Button size="sm" variant="ghost" icon={<Funnel />} onClick={() => update({ trade: null })}>
                Only my trade ({me.trade.name})
              </Button>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary-soft py-1 pr-1 pl-3 text-sm font-medium text-primary-ink">
                <Funnel aria-hidden size={14} className="shrink-0" />
                My trade: {me.trade.name}
                <button
                  type="button"
                  className="inline-flex size-7 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-primary/15"
                  aria-label="Remove trade filter"
                  onClick={() => update({ trade: "all" })}
                >
                  <X aria-hidden size={14} weight="bold" />
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
    <div className="space-y-6">
      <PageHeader
        eyebrow={<BackLink to="/student/projects">Back to catalogue</BackLink>}
        title={p.title}
        description={p.project_code}
      />
      <div className="flex flex-col gap-6">
        {isMine && (
          <div className="flex flex-col gap-3 rounded-xl border border-success/30 bg-success-bg p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-2.5 text-sm text-success">
              <CheckCircle aria-hidden size={20} weight="fill" className="shrink-0" />
              <span className="font-semibold">Your allocated project</span>
              <StatusBadge kind="progress" value="allocated" />
            </div>
            <LinkButton to="/student/submission" variant="secondary" size="sm" icon={<Kanban />} trailing>
              Go to My project & submission
            </LinkButton>
          </div>
        )}
        <ProjectDetailView project={p} />
        {rec && (
          <section aria-label="Your match for this project">
            <h2 className="mb-3 text-base font-semibold">Why it was suggested to you</h2>
            <StudentRecommendationCard recommendation={rec} compact />
          </section>
        )}
      </div>
    </div>
  );
}
