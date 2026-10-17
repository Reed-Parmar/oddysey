/** /admin/projects, /admin/projects/new, /admin/projects/:projectId (PRJ-01..06, IMP-02, REC-03; admin.md §3.4). */
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Archive, ArrowCounterClockwise, FolderSimple, Gauge, PaperPlaneTilt, PencilSimple, Plus, Sparkle, Trash, UploadSimple,
  Warning,
} from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Controller, useForm, type UseFormReturn } from "react-hook-form";
import { Link, useNavigate, useParams } from "react-router-dom";
import { z } from "zod";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Project, ProjectCreate, ProjectPatch } from "@/api/types";
import { useCurrentCycle } from "@/app/AppShell";
import {
  Avatar, BackLink, ConfirmDialog, DataTable, EmptyState, ErrorState, FormField, LoadingState, Meter, PageHeader,
  Pagination, StatusBadge, useToast, type Column,
} from "@/components/shared";
import { Button, Card, Input, Select, Textarea } from "@/components/ui";
import { ProjectDetailView, RecommendationCard } from "@/features/shared/views";
import { formatScore } from "@/lib/format";

import {
  ActionStack, ApiErrorAlert, CapacityBar, CardState, CycleSelect, FilterBar, FormSection, LabeledSelect, LinkButton,
  MetaLine, ReadOnlyBanner, Reason, SearchInput, SkillsInput, StatusTrack, TableCard, TextLink, WarningsAlert,
  applyFieldErrors, useActiveSupervisors, useDebounced, useInvalidate, useScopedCycle, useTrades,
} from "./common";
import { ImportDialog } from "./ImportPanel";

// ---------------------------------------------------------------- list

export function ProjectsPage() {
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [cycleSel, setCycleSel] = useState("");
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [trade, setTrade] = useState("");
  const [difficulty, setDifficulty] = useState("");
  const [supervisor, setSupervisor] = useState("");
  const [sort, setSort] = useState("title");
  const [page, setPage] = useState(1);
  const [importOpen, setImportOpen] = useState(false);
  const dq = useDebounced(q.trim());
  const scope = useScopedCycle(cycleSel);
  const trades = useTrades();
  const sups = useActiveSupervisors();

  const query = {
    cycle_id: scope.id, q: dq || undefined, status: (status || undefined) as Project["status"] | undefined,
    trade_id: trade || undefined, difficulty: (difficulty || undefined) as Project["difficulty"] | undefined,
    supervisor_id: supervisor || undefined, sort, page, page_size: 20,
  };
  const list = useQuery({
    queryKey: qk.projects.list(query),
    queryFn: () => call(api.GET("/api/v1/projects", { params: { query } })),
    enabled: !!scope.id,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const writeReason = !scope.id ? "Create a cycle first" : scope.cycle?.status === "archived" ? "Cycle is archived (read-only)" : undefined;
  const newReason = writeReason ?? (scope.active && scope.id !== scope.active.id ? "New projects go into the active cycle; switch back to it" : undefined);
  const filtered = !!(dq || status || trade || difficulty || supervisor);

  const cols: Column<Project>[] = [
    { key: "code", header: "Code", sort: "project_code", cell: (p) => <span className="font-medium whitespace-nowrap text-muted tabular-nums">{p.project_code}</span> },
    { key: "title", header: "Title", sort: "title", className: "min-w-56", cell: (p) => (
      <span className="block">
        <Link className="font-semibold text-text hover:text-primary hover:underline" to={`/admin/projects/${p.id}`} onClick={(e) => e.stopPropagation()}>{p.title}</Link>
        {p.category && <span className="mt-0.5 block text-xs text-muted">{p.category}</span>}
      </span>
    ) },
    { key: "trade", header: "Trade", cell: (p) => <span className="whitespace-nowrap">{p.target_trade.name}</span> },
    { key: "difficulty", header: "Difficulty", cell: (p) => <StatusBadge kind="difficulty" value={p.difficulty} /> },
    { key: "min", header: "Min practical", className: "text-right tabular-nums", cell: (p) => `${formatScore(p.min_practical_score)}%` },
    { key: "cap", header: "Allocated / capacity", cell: (p) => <CapacityBar value={p.stats?.allocated_count ?? 0} max={p.max_trainees} label={`${p.project_code} allocated of capacity`} /> },
    { key: "elig", header: "Eligible", className: "text-right tabular-nums", cell: (p) => p.stats?.eligible_trainee_count ?? "—" },
    { key: "sup", header: "Supervisor", cell: (p) => p.supervisor ? (
      <span className="flex items-center gap-2 whitespace-nowrap"><Avatar name={p.supervisor.full_name} size="sm" />{p.supervisor.full_name}</span>
    ) : <span className="inline-flex items-center gap-1 font-medium whitespace-nowrap text-warning"><Warning aria-hidden size={14} />Not assigned</span> },
    { key: "status", header: "Status", cell: (p) => <StatusBadge kind="project" value={p.status} /> },
  ];

  return (
    <div>
      <PageHeader title="Projects" description="The project catalogue for a cycle. Assign a supervisor and publish a project before recommendations can use it."
        actions={<ActionStack reason={newReason}>
          <Button variant="secondary" icon={<UploadSimple />} disabled={!!writeReason} onClick={() => setImportOpen(true)}>Import projects</Button>
          <Button icon={<Plus />} disabled={!!newReason} onClick={() => navigate("/admin/projects/new")}>New project</Button>
        </ActionStack>} />
      {scope.isLoading ? <LoadingState /> : scope.error ? <ErrorState error={scope.error} /> : !scope.id ? (
        <EmptyState icon={<FolderSimple />} title="No active cycle" description="Create a cycle before adding projects."
          action={<LinkButton to="/admin/cycles?create=1">Create a cycle</LinkButton>} />
      ) : (
        <TableCard
          title="Project catalogue" icon={<FolderSimple />}
          description={list.data ? `${list.data.meta.total} ${list.data.meta.total === 1 ? "project" : "projects"}${filtered ? " match these filters" : ""}${scope.cycle ? ` in ${scope.cycle.name}` : ""}` : undefined}
          toolbar={<FilterBar>
            <CycleSelect value={scope.id} onChange={reset(setCycleSel)} cycles={scope.cycles} activeId={scope.active?.id} />
            <SearchInput id="project-q" label="Search" value={q} onChange={reset(setQ)} placeholder="Code or title" />
            <LabeledSelect id="project-status" label="Status" value={status} onChange={reset(setStatus)}>
              <option value="">All statuses</option><option value="draft">Draft</option>
              <option value="published">Published</option><option value="archived">Archived</option>
            </LabeledSelect>
            <LabeledSelect id="project-trade" label="Trade" value={trade} onChange={reset(setTrade)}>
              <option value="">All trades</option>
              {(trades.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </LabeledSelect>
            <LabeledSelect id="project-difficulty" label="Difficulty" value={difficulty} onChange={reset(setDifficulty)}>
              <option value="">Any</option><option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option><option value="advanced">Advanced</option>
            </LabeledSelect>
            <LabeledSelect id="project-sup" label="Supervisor" value={supervisor} onChange={reset(setSupervisor)}>
              <option value="">Any</option>
              {(sups.data?.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
            </LabeledSelect>
            <LabeledSelect id="project-sort" label="Sort" value={sort} onChange={reset(setSort)}>
              <option value="title">Title</option><option value="project_code">Code</option><option value="-created_at">Newest first</option>
            </LabeledSelect>
          </FilterBar>}
          footer={list.data?.data.length ? <Pagination meta={list.data.meta} onPageChange={setPage} /> : undefined}>
          {list.isLoading ? <CardState><LoadingState /></CardState> : list.error ? <CardState><ErrorState error={list.error} onRetry={() => list.refetch()} /></CardState> :
            !list.data?.data.length ? (
              <CardState>
                {filtered ? <EmptyState icon={<FolderSimple />} title="No projects match these filters" /> : (
                  <EmptyState icon={<FolderSimple />} title="No projects yet" description="Import the Project Catalog sheet or create one."
                    action={!writeReason ? <Button icon={<UploadSimple />} onClick={() => setImportOpen(true)}>Import projects</Button> : undefined} />
                )}
              </CardState>
            ) : (
              <DataTable rows={list.data.data} columns={cols} rowKey={(p) => p.id} sort={sort} onSortChange={reset(setSort)}
                onRowClick={(p) => navigate(`/admin/projects/${p.id}`)} caption="Projects" />
            )}
        </TableCard>
      )}
      {scope.id && (
        <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} endpoint="/admin/imports/projects" cycleId={scope.id}
          noun="projects" onApplied={() => invalidate(qk.projects.all(), qk.trades.all(), qk.skills.all(), qk.reports.all())} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- shared editor

const projectSchema = z.object({
  project_code: z.string().trim().regex(/^[A-Za-z0-9-]{1,40}$/, "1–40 letters, digits or hyphens"),
  title: z.string().trim().min(5, "At least 5 characters").max(200, "At most 200 characters"),
  description: z.string().trim().max(5000, "At most 5000 characters"),
  problem_doc_url: z.string().trim().max(2048).refine((v) => v === "" || /^https:\/\/\S+$/.test(v), "Must be an https:// link"),
  target_trade_id: z.string().min(1, "Choose a trade"),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]),
  min_practical_score: z.string().trim().refine((v) => v !== "" && !Number.isNaN(Number(v)) && Number(v) >= 0 && Number(v) <= 100, "0–100"),
  max_trainees: z.string().trim().refine((v) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 100, "Whole number 1–100"),
  category: z.string().trim().max(120, "At most 120 characters"),
  supervisor_id: z.string(),
  skills: z.array(z.string()).max(15, "At most 15 skills"),
});
type ProjectForm = z.infer<typeof projectSchema>;
const PROJECT_FIELDS = Object.keys(projectSchema.shape) as (keyof ProjectForm)[];
const EMPTY: ProjectForm = {
  project_code: "", title: "", description: "", problem_doc_url: "", target_trade_id: "", difficulty: "beginner",
  min_practical_score: "", max_trainees: "", category: "", supervisor_id: "", skills: [],
};

function toForm(p: Project): ProjectForm {
  return {
    project_code: p.project_code, title: p.title, description: p.description ?? "", problem_doc_url: p.problem_doc_url ?? "",
    target_trade_id: p.target_trade.id, difficulty: p.difficulty, min_practical_score: String(p.min_practical_score),
    max_trainees: String(p.max_trainees), category: p.category ?? "", supervisor_id: p.supervisor?.id ?? "",
    skills: p.skills.map((s) => s.name),
  };
}

const opt = (v: string) => (v.trim() === "" ? null : v.trim());

/** Changed fields only (PRJ-04); `skills` replaces the set. */
export function projectPatch(before: ProjectForm, v: ProjectForm): ProjectPatch {
  const b: ProjectPatch = {};
  if (v.project_code.trim() !== before.project_code) b.project_code = v.project_code.trim();
  if (v.title.trim() !== before.title) b.title = v.title.trim();
  if (v.description.trim() !== before.description) b.description = opt(v.description);
  if (v.problem_doc_url.trim() !== before.problem_doc_url) b.problem_doc_url = opt(v.problem_doc_url);
  if (v.target_trade_id !== before.target_trade_id) b.target_trade_id = v.target_trade_id;
  if (v.difficulty !== before.difficulty) b.difficulty = v.difficulty;
  if (Number(v.min_practical_score) !== Number(before.min_practical_score)) b.min_practical_score = Number(v.min_practical_score);
  if (Number(v.max_trainees) !== Number(before.max_trainees)) b.max_trainees = Number(v.max_trainees);
  if (v.category.trim() !== before.category) b.category = opt(v.category);
  if (v.supervisor_id !== before.supervisor_id) b.supervisor_id = v.supervisor_id || null;
  const norm = (a: string[]) => a.map((x) => x.toLowerCase()).sort().join("\n");
  if (norm(v.skills) !== norm(before.skills)) b.skills = v.skills;
  return b;
}

function ProjectFormFields({ form, disabled, currentSupervisor }: {
  form: UseFormReturn<ProjectForm>; disabled?: boolean; currentSupervisor?: Project["supervisor"];
}) {
  const trades = useTrades();
  const sups = useActiveSupervisors();
  const err = form.formState.errors;
  const supOptions = sups.data?.data ?? [];
  const showCurrent = currentSupervisor && !supOptions.some((u) => u.id === currentSupervisor.id);
  return (
    <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-6">
      <FormSection title="Basics">
      <FormField label="Project code" htmlFor="pj-code" required error={err.project_code?.message} hint="e.g. PRJ-EL-101">
        <Input id="pj-code" maxLength={40} {...form.register("project_code")} />
      </FormField>
      <FormField label="Title" htmlFor="pj-title" required error={err.title?.message}>
        <Input id="pj-title" maxLength={200} {...form.register("title")} />
      </FormField>
      <div className="md:col-span-2">
        <FormField label="Description" htmlFor="pj-desc" error={err.description?.message}>
          <Textarea id="pj-desc" maxLength={5000} {...form.register("description")} />
        </FormField>
      </div>
      <FormField label="Problem statement document" htmlFor="pj-doc" error={err.problem_doc_url?.message} hint="An https:// link">
        <Input id="pj-doc" type="url" maxLength={2048} placeholder="https://" {...form.register("problem_doc_url")} />
      </FormField>
      <FormField label="Category / sponsor goal" htmlFor="pj-cat" error={err.category?.message}>
        <Input id="pj-cat" maxLength={120} {...form.register("category")} />
      </FormField>
      </FormSection>
      <FormSection title="Matching rules" description="Used by the recommendation engine: trade and minimum practical score are hard gates.">
      <FormField label="Target trade" htmlFor="pj-trade" required error={err.target_trade_id?.message}>
        <Select id="pj-trade" {...form.register("target_trade_id")}>
          <option value="">Choose a trade</option>
          {(trades.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </FormField>
      <FormField label="Difficulty" htmlFor="pj-diff" required error={err.difficulty?.message}>
        <Select id="pj-diff" {...form.register("difficulty")}>
          <option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option>
        </Select>
      </FormField>
      <div className="grid grid-cols-2 gap-3 md:col-span-2 md:gap-4">
        <FormField label="Min practical %" htmlFor="pj-min" required error={err.min_practical_score?.message}>
          <Input id="pj-min" inputMode="decimal" {...form.register("min_practical_score")} />
        </FormField>
        <FormField label="Capacity" htmlFor="pj-cap" required error={err.max_trainees?.message} hint="Trainees">
          <Input id="pj-cap" inputMode="numeric" {...form.register("max_trainees")} />
        </FormField>
      </div>
      <div className="md:col-span-2">
        <FormField label="Prerequisite skills" htmlFor="pj-skills" error={err.skills?.message} hint="Up to 15. New names are created automatically.">
          <Controller control={form.control} name="skills" render={({ field }) => (
            <SkillsInput id="pj-skills" value={field.value} onChange={field.onChange} disabled={disabled} />
          )} />
        </FormField>
      </div>
      </FormSection>
      <FormSection title="Supervision">
      <FormField label="Supervisor" htmlFor="pj-sup" error={err.supervisor_id?.message}
        hint={sups.isLoading ? "Loading supervisors…" : !supOptions.length ? <span>No active supervisors. <TextLink to="/admin/users">Invite one</TextLink></span> : "Required before publishing"}>
        <Select id="pj-sup" {...form.register("supervisor_id")}>
          <option value="">Not assigned</option>
          {showCurrent && <option value={currentSupervisor.id}>{currentSupervisor.full_name} (inactive)</option>}
          {supOptions.map((u) => <option key={u.id} value={u.id}>{u.full_name}{u.department ? ` (${u.department})` : ""}</option>)}
        </Select>
      </FormField>
      </FormSection>
    </fieldset>
  );
}

function mapProjectErrors(e: unknown, setError: UseFormReturn<ProjectForm>["setError"]): boolean {
  return applyFieldErrors(e, setError, PROJECT_FIELDS, { DUPLICATE_CODE: "project_code", CAPACITY_BELOW_ALLOCATED: "max_trainees" });
}

function useProjectInvalidate() {
  const inv = useInvalidate();
  return (extra: readonly unknown[][] = []) => inv(qk.projects.all(), qk.reports.all(), ...extra);
}

// ---------------------------------------------------------------- new

export function ProjectNewPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useProjectInvalidate();
  const current = useCurrentCycle();
  const cycle = current.data?.data ?? null;
  const form = useForm<ProjectForm>({ resolver: zodResolver(projectSchema), defaultValues: EMPTY });
  const [alertError, setAlertError] = useState<unknown>(null);
  const m = useMutation({
    onMutate: () => setAlertError(null),
    mutationFn: (v: ProjectForm) => {
      const body: ProjectCreate = {
        cycle_id: cycle!.id, project_code: v.project_code.trim(), title: v.title.trim(), description: opt(v.description),
        problem_doc_url: opt(v.problem_doc_url), target_trade_id: v.target_trade_id, difficulty: v.difficulty,
        min_practical_score: Number(v.min_practical_score), max_trainees: Number(v.max_trainees), category: opt(v.category),
        supervisor_id: v.supervisor_id || null, skills: v.skills,
      };
      return call(api.POST("/api/v1/projects", { body }));
    },
    onSuccess: (res) => {
      invalidate([qk.skills.all()]);
      toast.success("Project created as Draft");
      navigate(`/admin/projects/${res.data.id}`);
    },
    onError: (e) => { if (!mapProjectErrors(e, form.setError)) setAlertError(e); },
  });

  if (current.isLoading) return <LoadingState />;
  if (current.error) return <ErrorState error={current.error} onRetry={() => current.refetch()} />;
  return (
    <div>
      <PageHeader title="New project" eyebrow={<BackLink to="/admin/projects">All projects</BackLink>}
        description="New projects start as Draft. Publish them from the project page once a supervisor is assigned." />
      {!cycle ? (
        <EmptyState icon={<FolderSimple />} title="No active cycle" description="Create a cycle first." action={<LinkButton to="/admin/cycles?create=1">Create a cycle</LinkButton>} />
      ) : (
        <Card title={`Project in ${cycle.name}`} icon={<FolderSimple />} className="max-w-4xl">
          <form noValidate className="flex flex-col gap-5" onSubmit={form.handleSubmit((v) => m.mutate(v))}>
            <ApiErrorAlert error={alertError} />
            <ProjectFormFields form={form} />
            <div className="flex flex-wrap gap-2 border-t border-border pt-4">
              <Button type="submit" icon={<Plus />} loading={m.isPending}>Create project</Button>
              <Button variant="secondary" onClick={() => navigate("/admin/projects")}>Cancel</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- detail

export function ProjectDetailPage() {
  const { projectId = "" } = useParams();
  const q = useQuery({
    queryKey: qk.projects.detail(projectId),
    queryFn: () => call(api.GET("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId } } })),
  });
  const cycleId = q.data?.data.cycle_id ?? "";
  const cycle = useQuery({
    queryKey: qk.cycles.detail(cycleId),
    queryFn: () => call(api.GET("/api/v1/cycles/{cycle_id}", { params: { path: { cycle_id: cycleId } } })),
    enabled: !!cycleId,
  });
  const [warnings, setWarnings] = useState<string[]>([]);
  if (q.isLoading) return <LoadingState />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const p = q.data.data;
  const archivedCycle = cycle.data?.data.status === "archived";
  return (
    <div className="space-y-6">
      <PageHeader title={p.title} eyebrow={<BackLink to="/admin/projects">All projects</BackLink>}
        description={<MetaLine items={[
          <span key="c" className="font-medium tabular-nums">{p.project_code}</span>,
          p.target_trade.name,
          cycle.data ? cycle.data.data.name : null,
        ]} />}
        actions={<StatusBadge kind="project" value={p.status} />} />
      {archivedCycle && <ReadOnlyBanner />}
      <WarningsAlert warnings={warnings} onDismiss={() => setWarnings([])} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <ProjectDetailView project={p} />
        <div className="flex min-w-0 flex-col gap-6">
          <Card title="Status" icon={<PaperPlaneTilt />} description="Only published projects are scored and allocated.">
            <div className="flex flex-col gap-4">
              <StatusTrack current={p.status} stages={[
                { key: "draft", label: "Draft" }, { key: "published", label: "Published" }, { key: "archived", label: "Archived" },
              ]} />
              <ProjectActions project={p} readOnly={archivedCycle} />
            </div>
          </Card>
          <Card title="Capacity" icon={<Gauge />}>
            <div className="flex flex-col gap-4">
              <Meter label="Allocated" value={p.stats?.allocated_count ?? 0} max={p.max_trainees}
                tone={(p.stats?.allocated_count ?? 0) >= p.max_trainees ? "success" : "primary"} />
              <p className="flex items-center justify-between gap-2 text-sm">
                <span className="text-muted">Eligible trainees (latest run)</span>
                <span className="font-semibold tabular-nums">{p.stats?.eligible_trainee_count ?? "—"}</span>
              </p>
            </div>
          </Card>
        </div>
      </div>
      <BestMatches project={p} />
      <ProjectEditForm key={p.updated_at} project={p} readOnly={archivedCycle} onWarnings={setWarnings} />
    </div>
  );
}

type PTarget = "draft" | "published" | "archived";
const P_ICON: Record<PTarget, ReactNode> = { published: <PaperPlaneTilt />, draft: <ArrowCounterClockwise />, archived: <Archive /> };
const P_TRANSITIONS: Record<Project["status"], { to: PTarget; label: string }[]> = {
  draft: [{ to: "published", label: "Publish" }, { to: "archived", label: "Archive" }],
  published: [{ to: "draft", label: "Move to draft" }, { to: "archived", label: "Archive" }],
  archived: [{ to: "draft", label: "Restore to draft" }],
};

function ProjectActions({ project, readOnly }: { project: Project; readOnly: boolean }) {
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useProjectInvalidate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const t = useMutation({
    mutationFn: (to: PTarget) => call(api.POST("/api/v1/projects/{project_id}/transition", { params: { path: { project_id: project.id } }, body: { to } })),
    onSuccess: (res) => { invalidate(); toast.success(`Project is now ${res.data.status === "draft" ? "Draft" : res.data.status === "published" ? "Published" : "Archived"}`); },
  });
  const del = useMutation({
    mutationFn: () => call(api.DELETE("/api/v1/projects/{project_id}", { params: { path: { project_id: project.id } } })),
    onSuccess: () => { invalidate(); toast.success("Project deleted"); navigate("/admin/projects"); },
    onSettled: () => setConfirmDelete(false),
  });
  const reason = readOnly ? "Cycle is archived (read-only)" : undefined;
  const publishReason = !project.supervisor ? "Assign a supervisor before publishing" : undefined;
  return (
    <div className="flex flex-col items-start gap-2">
      <div className="flex flex-wrap gap-2">
        {P_TRANSITIONS[project.status].map((o) => (
          <Button key={o.to} size="sm" icon={P_ICON[o.to]} variant={o.to === "published" ? "primary" : "secondary"}
            disabled={!!reason || (o.to === "published" && !!publishReason) || del.isPending}
            loading={t.isPending && t.variables === o.to} onClick={() => { del.reset(); t.mutate(o.to); }}>{o.label}</Button>
        ))}
        {project.status === "draft" && (
          <Button size="sm" variant="danger" icon={<Trash />} disabled={!!reason || t.isPending} onClick={() => setConfirmDelete(true)}>Delete</Button>
        )}
      </div>
      <Reason>{reason ?? (project.status === "draft" ? publishReason : undefined)}</Reason>
      <ApiErrorAlert error={t.error} />
      <ApiErrorAlert error={del.error} extra={{ RESOURCE_IN_USE: "Project has recommendations or allocations; archive it instead." }} />
      <ConfirmDialog open={confirmDelete} title={`Delete ${project.project_code}?`} danger confirmLabel="Delete project" loading={del.isPending}
        message="This draft project will be removed permanently. This cannot be undone." onClose={() => setConfirmDelete(false)} onConfirm={() => { t.reset(); del.mutate(); }} />
    </div>
  );
}

function ProjectEditForm({ project, readOnly, onWarnings }: { project: Project; readOnly: boolean; onWarnings: (w: string[]) => void }) {
  const toast = useToast();
  const invalidate = useProjectInvalidate();
  const initial = toForm(project);
  const form = useForm<ProjectForm>({ resolver: zodResolver(projectSchema), defaultValues: initial });
  const [alertError, setAlertError] = useState<unknown>(null);
  const m = useMutation({
    onMutate: () => setAlertError(null),
    mutationFn: (body: ProjectPatch) => call(api.PATCH("/api/v1/projects/{project_id}", { params: { path: { project_id: project.id } }, body })),
    onSuccess: (res) => {
      onWarnings(res.meta?.warnings ?? []);
      invalidate([qk.skills.all(), qk.allocations.all(), qk.progress.all()]);
      toast.success("Project saved");
    },
    onError: (e) => { if (!mapProjectErrors(e, form.setError)) setAlertError(e); },
  });
  return (
    <Card title="Edit project" icon={<PencilSimple />} description="Only changed fields are saved.">
      {readOnly && <p className="mb-3 text-xs text-muted">Cycle is archived (read-only).</p>}
      <form noValidate className="flex flex-col gap-5" onSubmit={form.handleSubmit((v) => {
        const body = projectPatch(initial, v);
        if (!Object.keys(body).length) { toast.info("No changes to save"); return; }
        m.mutate(body);
      })}>
        <ApiErrorAlert error={alertError} />
        <ProjectFormFields form={form} disabled={readOnly} currentSupervisor={project.supervisor} />
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <Button type="submit" loading={m.isPending} disabled={readOnly || !form.formState.isDirty}>Save changes</Button>
          <Button variant="secondary" disabled={readOnly || !form.formState.isDirty || m.isPending} onClick={() => form.reset(initial)}>Discard changes</Button>
        </div>
      </form>
    </Card>
  );
}

function BestMatches({ project }: { project: Project }) {
  const [eligibleOnly, setEligibleOnly] = useState(true);
  const [page, setPage] = useState(1);
  const params = { cycle_id: project.cycle_id, project_id: project.id, sort: "-score", eligible_only: eligibleOnly, page, page_size: 10 };
  const q = useQuery({
    queryKey: qk.recommendations.list(params),
    queryFn: () => call(api.GET("/api/v1/recommendations", { params: { query: params } })),
  });
  return (
    <Card title="Best-matching trainees" icon={<Sparkle />} description="Latest completed run, highest score first" actions={
      <label className="inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-lg border border-border-strong bg-surface px-3 text-sm font-medium shadow-card">
        <input type="checkbox" className="size-4 accent-primary" checked={eligibleOnly} onChange={(e) => { setEligibleOnly(e.target.checked); setPage(1); }} />
        Eligible only
      </label>
    }>
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.data.length ? (
        <EmptyState icon={<Sparkle />} title={eligibleOnly ? "No eligible trainees in the latest run" : "No recommendations yet"}
          description={project.status !== "published" ? "Only published projects are scored." : undefined}
          action={<LinkButton to="/admin/recommendations">Run recommendations</LinkButton>} />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {q.data.data.map((r) => (
              <RecommendationCard key={r.id} recommendation={r} compact perspective="project"
                actions={<TextLink to={`/admin/trainees/${r.trainee.id}`}>View trainee</TextLink>} />
            ))}
          </div>
          <Pagination meta={q.data.meta} onPageChange={setPage} />
        </div>
      )}
    </Card>
  );
}

