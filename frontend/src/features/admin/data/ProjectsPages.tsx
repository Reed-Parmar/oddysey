/** /admin/projects, /admin/projects/new, /admin/projects/:projectId (ADR-017: document-driven projects, automatic processing). */
import {
  Archive, ArrowClockwise, FileArrowUp, FolderSimple, Pause, PencilSimple, Play, Plus, Sparkle, Trash, UploadSimple, UsersThree,
  Warning, WarningCircle,
} from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { ApiError } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Allocation, Project, ProjectPatch } from "@/api/types";
import { uploadMultipart } from "@/api/upload";
import {
  Avatar, BackLink, ConfirmDialog, DataTable, EmptyState, ErrorState, FileField, FormField, LoadingState, PageHeader,
  Pagination, StatusBadge, useToast, type Column,
} from "@/components/shared";
import { Alert, Button, Card, Input, Select, Textarea, cx } from "@/components/ui";
import { ProjectDetailView, ProjectGuide, tradeNames } from "@/features/shared/views";
import { formatBytes, formatScore } from "@/lib/format";
import { label } from "@/lib/statusLabels";

import {
  ApiErrorAlert, CardState, CycleSelect, FilterBar, IstDateTime, LabeledSelect, LinkButton, MetaLine, ReadOnlyBanner,
  SearchInput, SkillsInput, TableCard, WarningsAlert, formatIst, fromLocalInput, toLocalInput, useActiveSupervisors,
  useDebounced, useInvalidate, useScopedCycle, useTrades,
} from "./common";
import { ImportDialog } from "./ImportPanel";
import { sendMultipart } from "./sendMultipart";

const DOC_ACCEPT = ".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC_MAX = 10 * 1024 * 1024;
const PROCESSING = ["awaiting_document", "queued", "processing", "awaiting_supervisor", "needs_attention", "ready", "failed"] as const;
const isBusy = (s: Project["processing_status"]) => s === "queued" || s === "processing";

const PROJECT_IMPORT_NOTES = (
  <ul className="list-disc space-y-0.5 pl-5">
    <li>"Project ID" is optional: a code (PRJ-0001…) is generated when it is blank. Existing dataset codes are kept on re-import.</li>
    <li>Several trades can be listed in one cell, separated by commas.</li>
    <li>The legacy "Max Trainee Capacity" column is ignored: every trainee works individually and there is no capacity.</li>
  </ul>
);

/** Maps document upload errors to a clear sentence (413/415/422 DOCUMENT_*). */
function documentError(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  if (e.status === 413 || e.code === "FILE_TOO_LARGE") return "The document is larger than 10 MB. Compress it or split out attachments, then upload again.";
  if (e.status === 415 || e.code === "UNSUPPORTED_FILE_TYPE") return "Upload the project document as a PDF or Word (.docx) file.";
  if (e.code === "DOCUMENT_NO_TEXT") return "No text could be read from this document. It looks like a scanned image; upload a PDF or DOCX that contains selectable text.";
  if (e.code === "DOCUMENT_UNREADABLE") return "This document could not be opened. It may be damaged or password-protected; save a fresh copy and upload again.";
  return null;
}

// ---------------------------------------------------------------- list

export function ProjectsPage() {
  const [params, setParams] = useSearchParams();
  const invalidate = useInvalidate();
  const [q, setQ] = useState("");
  const [processing, setProcessing] = useState("");
  const [page, setPage] = useState(1);
  const [importOpen, setImportOpen] = useState(false);
  const dq = useDebounced(q.trim());
  const scope = useScopedCycle(params.get("cycle") ?? "");

  const query = {
    cycle_id: scope.id, q: dq || undefined,
    processing_status: (processing || undefined) as Project["processing_status"] | undefined,
    sort: "title", page, page_size: 20,
  };
  const list = useQuery({
    queryKey: qk.projects.list(query),
    queryFn: () => call(api.GET("/api/v1/projects", { params: { query } })),
    enabled: !!scope.id,
    refetchInterval: (qr) => (qr.state.data?.data.some((p) => isBusy(p.processing_status)) ? 5000 : false),
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const archived = scope.cycle?.status === "archived";
  const writeReason = !scope.id ? "Create a cycle first (Overview)" : archived ? "This cycle is archived (read-only)" : undefined;
  const filtered = !!(dq || processing);

  const cols: Column<Project>[] = [
    { key: "code", header: "Code", sort: "project_code", cell: (p) => <span className="font-medium whitespace-nowrap text-muted tabular-nums">{p.project_code}</span> },
    { key: "title", header: "Title", sort: "title", className: "min-w-56", cell: (p) => (
      <span className="block">
        <Link className="font-semibold text-text hover:text-primary hover:underline" to={`/admin/projects/${p.id}`}>{p.title}</Link>
        {p.category && <span className="mt-0.5 block text-xs text-muted">{p.category}</span>}
      </span>
    ) },
    { key: "trades", header: "Trades", cell: (p) => <span className="block min-w-32">{tradeNames(p)}</span> },
    { key: "status", header: "Processing", cell: (p) => (
      <span className="flex flex-col items-start gap-1">
        <StatusBadge kind="processing" value={p.processing_status} />
        {p.processing_status === "ready" && p.status !== "published" && <span className="text-xs text-muted">{p.status === "archived" ? "Archived" : "Allocation paused"}</span>}
      </span>
    ) },
    { key: "sup", header: "Supervisor", cell: (p) => p.supervisor ? (
      <span className="flex items-center gap-2 whitespace-nowrap"><Avatar name={p.supervisor.full_name} size="sm" />{p.supervisor.full_name}</span>
    ) : <span className="text-muted">Not assigned</span> },
    { key: "count", header: "Number of trainees working individually", className: "text-right tabular-nums", cell: (p) => p.stats?.working_individually ?? 0 },
    { key: "deadline", header: "Deadline", cell: (p) => (
      <span className="whitespace-nowrap">
        <IstDateTime value={p.effective_deadline} />
        {!p.deadline && p.effective_deadline && <span className="block text-xs text-muted">cycle default</span>}
      </span>
    ) },
  ];

  const createTo = `/admin/projects/new?cycle=${scope.id}`;
  return (
    <div className="space-y-6">
      <PageHeader title="Projects" eyebrow="Programme team"
        description="Add a title, a description and the project document. Code, trades, skills, difficulty, guide and supervisor are generated automatically."
        actions={writeReason ? <span className="text-sm text-muted">{writeReason}</span> : <>
          <Button variant="secondary" icon={<UploadSimple />} onClick={() => setImportOpen(true)}>Import projects</Button>
          <LinkButton variant="primary" icon={<Plus />} to={createTo}>Create project</LinkButton>
        </>} />
      {archived && <ReadOnlyBanner />}
      {scope.isLoading ? <LoadingState /> : scope.error ? <ErrorState error={scope.error} /> : !scope.id ? (
        <EmptyState icon={<FolderSimple />} title="No active cycle" description="Create a cycle on the Overview page first; projects belong to a cycle."
          action={<LinkButton variant="primary" to="/admin">Go to Overview</LinkButton>} />
      ) : (
        <TableCard
          toolbar={<FilterBar>
            <CycleSelect id="proj-cycle" value={scope.id} cycles={scope.cycles} activeId={scope.active?.id}
              onChange={(v) => { setParams(v ? { cycle: v } : {}); setPage(1); }} />
            <SearchInput id="proj-q" label="Search" value={q} onChange={reset(setQ)} placeholder="Title or code" />
            <LabeledSelect id="proj-processing" label="Processing status" value={processing} onChange={reset(setProcessing)}>
              <option value="">Any</option>
              {PROCESSING.map((s) => <option key={s} value={s}>{label("processing", s)[0]}</option>)}
            </LabeledSelect>
          </FilterBar>}
          footer={list.data?.data.length ? <Pagination meta={list.data.meta} onPageChange={setPage} /> : undefined}>
          {list.isLoading ? <CardState><LoadingState /></CardState> : list.error ? <CardState><ErrorState error={list.error} onRetry={() => void list.refetch()} /></CardState> :
            !list.data?.data.length ? (
              <CardState>
                {filtered ? <EmptyState icon={<FolderSimple />} title="No projects match these filters" /> : (
                  <EmptyState icon={<FolderSimple />} title="No projects in this cycle yet"
                    description={writeReason ?? "Create a project from its document, or import the Project Catalog sheet. Processing and allocation then run automatically."}
                    action={writeReason ? undefined : <div className="flex flex-wrap justify-center gap-2">
                      <LinkButton variant="primary" icon={<Plus />} to={createTo}>Create project</LinkButton>
                      <Button variant="secondary" icon={<UploadSimple />} onClick={() => setImportOpen(true)}>Import projects</Button>
                    </div>} />
                )}
              </CardState>
            ) : (
              <DataTable rows={list.data.data} columns={cols} rowKey={(p) => p.id} caption="Projects" />
            )}
        </TableCard>
      )}
      {scope.id && !archived && (
        <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} endpoint="/admin/imports/projects" cycleId={scope.id}
          noun="projects" notes={PROJECT_IMPORT_NOTES}
          onApplied={() => invalidate(qk.projects.all(), qk.reports.all(), qk.progress.all(), qk.automation.status())} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- new

export function ProjectNewPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidate();
  const scope = useScopedCycle(params.get("cycle") ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [errors, setErrors] = useState<{ title?: string; description?: string; file?: string }>({});
  const [formError, setFormError] = useState<unknown>(null);

  const m = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append("cycle_id", scope.id);
      form.append("title", title.trim());
      form.append("description", description.trim());
      form.append("file", file as File);
      setProgress(0);
      return uploadMultipart<{ data: Project }>("/projects", form, { onProgress: setProgress }).finally(() => setProgress(null));
    },
    onSuccess: (res) => {
      invalidate(qk.projects.all(), qk.reports.all());
      toast.success(`Project ${res.data.project_code} created; processing has started`);
      navigate(`/admin/projects/${res.data.id}`);
    },
    onError: (e) => {
      const doc = documentError(e);
      if (doc) { setErrors({ file: doc }); return; }
      if (e instanceof ApiError && e.code === "VALIDATION_ERROR") {
        const f = e.fieldErrors();
        const mapped = { title: f.title, description: f.description, file: f.file };
        if (mapped.title || mapped.description || mapped.file) { setErrors(mapped); return; }
      }
      setFormError(e);
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    const next: typeof errors = {};
    const t = title.trim();
    const d = description.trim();
    if (t.length < 5 || t.length > 200) next.title = "Use 5 to 200 characters";
    if (d.length < 10 || d.length > 5000) next.description = "Use 10 to 5000 characters";
    if (!file) next.file = "Attach the project document (PDF or DOCX, up to 10 MB)";
    setErrors(next);
    if (!Object.keys(next).length) m.mutate();
  };

  const archived = scope.cycle?.status === "archived";
  const back = `/admin/projects${scope.id ? `?cycle=${scope.id}` : ""}`;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title="Create project" eyebrow={<BackLink to={back}>Back to projects</BackLink>}
        description={scope.cycle ? <>Cycle <span className="font-medium text-text">{scope.cycle.name}</span></> : undefined} />
      {scope.isLoading ? <LoadingState /> : scope.error ? <ErrorState error={scope.error} /> : !scope.id ? (
        <EmptyState icon={<FolderSimple />} title="No active cycle" description="Create a cycle on the Overview page first."
          action={<LinkButton variant="primary" to="/admin">Go to Overview</LinkButton>} />
      ) : archived ? <ReadOnlyBanner /> : (
        <Card>
          <Alert variant="info" icon={<Sparkle />} title="Generated automatically">
            The project code, target trades, prerequisite skills, difficulty, execution guide and supervisor are generated from the document after upload.
            You can correct any of them afterwards on the project page.
          </Alert>
          <form noValidate className="mt-5 flex flex-col gap-4" onSubmit={submit}>
            <FormError error={formError} />
            <FormField label="Title" htmlFor="np-title" required error={errors.title} hint="5 to 200 characters.">
              <Input id="np-title" value={title} maxLength={200} aria-invalid={!!errors.title} onChange={(e) => setTitle(e.target.value)} />
            </FormField>
            <FormField label="Description" htmlFor="np-desc" required error={errors.description} hint="10 to 5000 characters: the problem, context and expected outcome.">
              <Textarea id="np-desc" rows={6} value={description} maxLength={5000} aria-invalid={!!errors.description} onChange={(e) => setDescription(e.target.value)} />
            </FormField>
            <FormField label="Project document" htmlFor="np-file" required hint="PDF or DOCX, up to 10 MB. It must contain readable text.">
              <FileField id="np-file" accept={DOC_ACCEPT} maxBytes={DOC_MAX} error={errors.file}
                onChange={(f) => { setFile(f); setErrors((x) => ({ ...x, file: undefined })); }} />
            </FormField>
            {file && <p className="text-xs text-muted">{file.name} · {formatBytes(file.size)}</p>}
            {progress != null && <UploadProgress value={progress} />}
            <div className="flex justify-end gap-2">
              <LinkButton to={back}>Cancel</LinkButton>
              <Button type="submit" icon={<FileArrowUp />} loading={m.isPending}>Create project</Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}

function FormError({ error }: { error: unknown }) {
  return error ? <ApiErrorAlert error={error} /> : null;
}

function UploadProgress({ value }: { value: number }) {
  const n = Math.round(value * 100);
  return (
    <div aria-live="polite" className="flex items-center gap-3 text-xs text-muted">
      <div role="progressbar" aria-label="Upload progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={n}
        className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-bg">
        <div className="h-full rounded-full bg-primary transition-[width] duration-150" style={{ width: `${n}%` }} />
      </div>
      <span className="tabular-nums">{n < 100 ? `Uploading ${n}%` : "Processing upload…"}</span>
    </div>
  );
}

// ---------------------------------------------------------------- detail

export function ProjectDetailPage() {
  const { projectId = "" } = useParams();
  const q = useQuery({
    queryKey: qk.projects.detail(projectId),
    queryFn: () => call(api.GET("/api/v1/projects/{project_id}", { params: { path: { project_id: projectId } } })),
    enabled: !!projectId,
    refetchInterval: (qr) => {
      const s = qr.state.data?.data.processing_status;
      return s && isBusy(s) ? 3000 : false;
    },
  });
  const p = q.data?.data;
  const scope = useScopedCycle(p?.cycle_id ?? "");
  if (q.isLoading) return <><PageHeader title="Project" eyebrow={<BackLink to="/admin/projects">Back to projects</BackLink>} /><LoadingState /></>;
  if (q.error || !p) return <><PageHeader title="Project" eyebrow={<BackLink to="/admin/projects">Back to projects</BackLink>} /><ErrorState error={q.error} onRetry={() => void q.refetch()} /></>;
  const readOnly = scope.cycle?.status === "archived";
  return (
    <div className="space-y-6">
      <PageHeader title={p.title} eyebrow={<BackLink to={`/admin/projects?cycle=${p.cycle_id}`}>Back to projects</BackLink>}
        description={<MetaLine items={[
          <span key="c" className="tabular-nums">{p.project_code}</span>,
          <StatusBadge key="p" kind="processing" value={p.processing_status} />,
          <span key="a">{p.status === "published" ? "Open for allocation" : p.status === "archived" ? "Archived" : "Allocation paused"}</span>,
          scope.cycle ? <span key="cy">Cycle {scope.cycle.name}</span> : null,
        ]} />} />
      {readOnly && <ReadOnlyBanner />}
      <ProcessingAlert project={p} readOnly={readOnly} />
      <ProjectDetailView project={p} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Execution guide" icon={<Sparkle />} description="Generated from the project document. Timelines are proposals only.">
          <ProjectGuide project={p} />
        </Card>
        <Provenance project={p} />
      </div>
      <Contributors project={p} />
      {!readOnly && (
        <>
          <EditProjectCard project={p} />
          <div className="grid gap-6 xl:grid-cols-2">
            <ReplaceDocumentCard project={p} />
            <AllocationControls project={p} />
          </div>
        </>
      )}
    </div>
  );
}

function useProjectInvalidate(projectId: string) {
  const invalidate = useInvalidate();
  return () => invalidate(qk.projects.detail(projectId), qk.projects.all(), qk.reports.all(), qk.progress.all(), qk.allocations.all());
}

function ProcessingAlert({ project: p, readOnly }: { project: Project; readOnly: boolean }) {
  const toast = useToast();
  const refresh = useProjectInvalidate(p.id);
  const retry = useMutation({
    mutationFn: () => call(api.POST("/api/v1/projects/{project_id}/reprocess", { params: { path: { project_id: p.id } } })),
    onSuccess: () => { toast.success("Processing queued again"); refresh(); },
  });
  const retryButton = !readOnly && (
    <Button size="sm" variant="secondary" icon={<ArrowClockwise />} loading={retry.isPending} onClick={() => retry.mutate()}>Retry processing</Button>
  );
  const s = p.processing_status;
  let body: ReactNode = null;
  if (isBusy(s)) {
    body = <Alert variant="info" icon={<Sparkle />} title={s === "queued" ? "Queued for processing" : "Processing the document…"}>
      Trades, skills, difficulty, the guide and the supervisor are being generated. This page refreshes automatically.
    </Alert>;
  } else if (s === "ready") {
    body = p.status === "published" ? null : (
      <Alert variant="info" icon={<Pause />} title={p.status === "archived" ? "Project archived" : "Allocation paused"}>
        {p.status === "archived" ? "Archived projects are not offered to trainees." : "The project is ready but not offered to trainees until you resume allocation below."}
      </Alert>
    );
  } else {
    const title = {
      awaiting_document: "Upload the project document",
      awaiting_supervisor: "Waiting for a supervisor",
      needs_attention: "Needs your attention",
      failed: "Processing failed",
    }[s];
    const fallback = {
      awaiting_document: "Upload a PDF or DOCX below so the project can be processed.",
      awaiting_supervisor: "No active supervisor matches this project yet. Choose a supervisor below, or invite one from Staff & Invitations; processing retries when staff change.",
      needs_attention: "Some generated details could not be confirmed. Check the trades and details below, correct them, then retry processing.",
      failed: "Processing did not finish. Retry processing; if it fails again, replace the document.",
    }[s];
    body = (
      <Alert variant={s === "failed" ? "danger" : "warning"} icon={s === "failed" ? <WarningCircle /> : <Warning />} title={title}>
        <p>{p.processing_error ?? fallback}</p>
        {s !== "awaiting_document" && retryButton && <div className="mt-2">{retryButton}</div>}
      </Alert>
    );
  }
  return body || retry.error ? <div className="flex flex-col gap-2">{body}<ApiErrorAlert error={retry.error} /></div> : null;
}

const SOURCE_LABEL: Record<string, string> = {
  ai: "AI generated from the document",
  rule: "Rule-based fallback (no AI)",
  import: "Imported from the spreadsheet",
  admin: "Entered or corrected by an admin",
};

function Provenance({ project: p }: { project: Project }) {
  const g = (p.generated ?? {}) as { confidence?: string | null; issues?: string[]; supervisor_selection?: unknown; model?: string };
  const sel = g.supervisor_selection;
  const selText = typeof sel === "string" ? sel : sel && typeof sel === "object"
    ? ((sel as { reason?: string; explanation?: string }).reason ?? (sel as { explanation?: string }).explanation ?? JSON.stringify(sel)) : null;
  return (
    <Card title="Generation details" icon={<Sparkle />} description="Where the project metadata came from.">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
        <dt className="text-muted">Source</dt>
        <dd className="font-medium">{p.generation_source ? SOURCE_LABEL[p.generation_source] ?? p.generation_source : "Not generated yet"}</dd>
        <dt className="text-muted">Confidence</dt>
        <dd className="font-medium">{g.confidence ? g.confidence.replace(/^\w/, (c) => c.toUpperCase()) : "—"}</dd>
        <dt className="text-muted">Issues</dt>
        <dd>{g.issues?.length ? (
          <ul className="flex flex-wrap gap-1.5">{g.issues.map((i) => (
            <li key={i} className="rounded-md border border-warning/30 bg-warning-bg px-2 py-0.5 text-xs font-medium text-warning">{i.replace(/_/g, " ")}</li>
          ))}</ul>
        ) : <span className="text-muted">None</span>}</dd>
        <dt className="text-muted">Supervisor selection</dt>
        <dd className="[overflow-wrap:anywhere]">{selText ?? <span className="text-muted">—</span>}</dd>
      </dl>
    </Card>
  );
}

// ---------------------------------------------------------------- contributors

function Contributors({ project: p }: { project: Project }) {
  const params = { project_id: p.id, cycle_id: p.cycle_id, page_size: 100 };
  const q = useQuery({
    queryKey: qk.allocations.list(params),
    queryFn: () => call(api.GET("/api/v1/allocations", { params: { query: params } })),
  });
  const rows = q.data?.data ?? [];
  const cols: Column<Allocation>[] = [
    { key: "t", header: "Trainee", cell: (a) => (
      <span className="flex min-w-44 items-center gap-2.5">
        <Avatar name={a.trainee.full_name} size="sm" />
        <span><span className="block font-semibold">{a.trainee.full_name}</span><span className="block text-xs text-muted">{a.trainee.trainee_code}</span></span>
      </span>
    ) },
    { key: "status", header: "Status", cell: (a) => <StatusBadge kind="allocationStatus" value={a.status} /> },
    { key: "match", header: "Match score", cell: (a) => (
      <span className="flex flex-col whitespace-nowrap">
        <span className="font-semibold tabular-nums">{formatScore(a.match_score)} / 100</span>
        {a.match_mode && <span className="text-xs text-muted">{label("matchMode", a.match_mode)[0]}</span>}
      </span>
    ) },
    { key: "trigger", header: "Source", cell: (a) => <span className="whitespace-nowrap">{a.trigger === "replacement" ? "Replacement" : a.trigger ? a.trigger.replace(/_/g, " ") : label("allocationSource", a.source)[0]}</span> },
    { key: "created", header: "Allocated", cell: (a) => <span className="whitespace-nowrap text-muted">{formatIst(a.created_at)}</span> },
  ];
  return (
    <Card flush title={`Number of trainees working individually: ${p.stats?.working_individually ?? rows.filter((a) => a.status === "active").length}`}
      icon={<UsersThree />} description="Each trainee works on this project individually, with their own submissions, evaluation and originality report.">
      <div className="px-5 pb-5">
        {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !rows.length ? (
          <EmptyState icon={<UsersThree />} title="No trainees allocated yet"
            description={p.processing_status === "ready" && p.status === "published" ? "Automatic allocation assigns eligible trainees on its next run." : "Trainees are allocated once the project is ready and open for allocation."} />
        ) : (
          <DataTable rows={rows} columns={cols} rowKey={(a) => a.id} caption="Trainees allocated to this project" />
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- edit

type EditState = {
  title: string; description: string; trade_ids: string[]; difficulty: string; skills: string[];
  min_practical_score: string; min_match_score: string; category: string; supervisor_id: string; deadline: string;
};

function initialEdit(p: Project): EditState {
  return {
    title: p.title, description: p.description ?? "", trade_ids: p.target_trades.map((t) => t.id), difficulty: p.difficulty ?? "",
    skills: p.skills.map((s) => s.name), min_practical_score: String(p.min_practical_score), min_match_score: String(p.min_match_score),
    category: p.category ?? "", supervisor_id: p.supervisor?.id ?? "", deadline: toLocalInput(p.deadline),
  };
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
const sameSkills = (a: string[], b: string[]) => sameSet(a.map((x) => x.toLowerCase()), b.map((x) => x.toLowerCase()));

function EditProjectCard({ project: p }: { project: Project }) {
  const toast = useToast();
  const refresh = useProjectInvalidate(p.id);
  const trades = useTrades();
  const sups = useActiveSupervisors();
  const init = initialEdit(p);
  const [v, setV] = useState(init);
  const [syncedFrom, setSyncedFrom] = useState(p.updated_at);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  if (syncedFrom !== p.updated_at) {
    setSyncedFrom(p.updated_at);
    setV(init);
  }
  const set = <K extends keyof EditState>(k: K, val: EditState[K]) => setV((x) => ({ ...x, [k]: val }));

  const body: ProjectPatch = {};
  if (v.title.trim() !== init.title) body.title = v.title.trim();
  if (v.description.trim() !== init.description) body.description = v.description.trim();
  if (!sameSet(v.trade_ids, init.trade_ids)) body.trade_ids = v.trade_ids;
  if (v.difficulty !== init.difficulty && v.difficulty) body.difficulty = v.difficulty as Project["difficulty"];
  if (!sameSkills(v.skills, init.skills)) body.skills = v.skills;
  if (Number(v.min_practical_score) !== Number(init.min_practical_score)) body.min_practical_score = Number(v.min_practical_score);
  if (Number(v.min_match_score) !== Number(init.min_match_score)) body.min_match_score = Number(v.min_match_score);
  if (v.category.trim() !== init.category) body.category = v.category.trim() || null;
  if (v.supervisor_id !== init.supervisor_id && v.supervisor_id) body.supervisor_id = v.supervisor_id;
  if (v.deadline !== init.deadline) body.deadline = v.deadline ? fromLocalInput(v.deadline) : null;
  const dirty = Object.keys(body).length > 0;

  const validate = (): Record<string, string> => {
    const e: Record<string, string> = {};
    const t = v.title.trim().length;
    if (t < 5 || t > 200) e.title = "Use 5 to 200 characters";
    const d = v.description.trim().length;
    if (d < 10 || d > 5000) e.description = "Use 10 to 5000 characters";
    if (!v.trade_ids.length) e.trade_ids = "Choose at least one trade";
    if (v.trade_ids.length > 5) e.trade_ids = "Choose at most 5 trades";
    for (const k of ["min_practical_score", "min_match_score"] as const) {
      const n = Number(v[k]);
      if (v[k] === "" || Number.isNaN(n) || n < 0 || n > 100) e[k] = "Enter a number from 0 to 100";
    }
    if (v.category.length > 120) e.category = "120 characters at most";
    return e;
  };

  const m = useMutation({
    mutationFn: () => call(api.PATCH("/api/v1/projects/{project_id}", { params: { path: { project_id: p.id } }, body })),
    onSuccess: (res) => {
      setWarnings(res.meta?.warnings ?? []);
      toast.success("Project saved");
      refresh();
    },
    onError: (e) => {
      if (e instanceof ApiError) setFieldErrors(e.fieldErrors());
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs = validate();
    setFieldErrors(errs);
    if (!Object.keys(errs).length && dirty) m.mutate();
  };
  const err = fieldErrors;
  const tradeList = trades.data?.data ?? [];
  return (
    <Card title="Correct project details" icon={<PencilSimple />} description="Only the fields you change are saved. Times are in India Standard Time (Asia/Kolkata).">
      <form noValidate className="flex flex-col gap-5" onSubmit={submit}>
        <WarningsAlert warnings={warnings} onDismiss={() => setWarnings([])} />
        {m.error != null && !(m.error instanceof ApiError && m.error.code === "VALIDATION_ERROR" && Object.keys(err).length) && <ApiErrorAlert error={m.error} />}
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FormField label="Title" htmlFor="ep-title" required error={err.title}>
            <Input id="ep-title" value={v.title} maxLength={200} onChange={(e) => set("title", e.target.value)} />
          </FormField>
          <FormField label="Category / sponsor goal" htmlFor="ep-category" error={err.category}>
            <Input id="ep-category" value={v.category} maxLength={120} onChange={(e) => set("category", e.target.value)} />
          </FormField>
          <div className="md:col-span-2">
            <FormField label="Description" htmlFor="ep-desc" required error={err.description}>
              <Textarea id="ep-desc" rows={5} value={v.description} maxLength={5000} onChange={(e) => set("description", e.target.value)} />
            </FormField>
          </div>
          <fieldset className="md:col-span-2">
            <legend className="text-sm font-semibold text-text">Target trades <span className="text-danger" aria-hidden>*</span></legend>
            <p className="mt-0.5 mb-2 text-xs text-muted">Trainees in any of these trades can be matched. Choose 1 to 5.</p>
            {trades.isLoading ? <p className="text-sm text-muted">Loading trades…</p> : trades.error ? <ErrorState error={trades.error} onRetry={() => void trades.refetch()} /> : (
              <div className="flex flex-wrap gap-2">
                {tradeList.map((t) => {
                  const on = v.trade_ids.includes(t.id);
                  return (
                    <label key={t.id} className={cx(
                      "inline-flex min-h-9 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm font-medium transition-colors has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-primary/20",
                      on ? "border-primary bg-primary-soft text-primary-ink" : "border-border-strong bg-surface hover:bg-surface-2",
                    )}>
                      <input type="checkbox" className="size-4 accent-primary" checked={on}
                        onChange={(e) => set("trade_ids", e.target.checked ? [...new Set([...v.trade_ids, t.id])] : v.trade_ids.filter((x) => x !== t.id))} />
                      {t.name}
                    </label>
                  );
                })}
              </div>
            )}
            {err.trade_ids && <p role="alert" className="mt-1 text-xs font-medium text-danger">{err.trade_ids}</p>}
          </fieldset>
          <FormField label="Difficulty" htmlFor="ep-diff">
            <Select id="ep-diff" value={v.difficulty} onChange={(e) => set("difficulty", e.target.value)}>
              {!v.difficulty && <option value="">Not set</option>}
              <option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option>
            </Select>
          </FormField>
          <FormField label="Supervisor" htmlFor="ep-sup" error={err.supervisor_id} hint="Active supervisors only.">
            <Select id="ep-sup" value={v.supervisor_id} onChange={(e) => set("supervisor_id", e.target.value)}>
              {!v.supervisor_id && <option value="">{sups.isLoading ? "Loading…" : "Not assigned"}</option>}
              {(sups.data?.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name}{u.department ? ` (${u.department})` : ""}</option>)}
              {p.supervisor && !(sups.data?.data ?? []).some((u) => u.id === p.supervisor?.id) && <option value={p.supervisor.id}>{p.supervisor.full_name}</option>}
            </Select>
          </FormField>
          <FormField label="Verified practical requirement (%)" htmlFor="ep-minp" error={err.min_practical_score}
            hint="When above 0, only trainees with a verified practical mark at or above this value can be allocated. 0 = no requirement.">
            <Input id="ep-minp" type="number" inputMode="decimal" min={0} max={100} step="0.5" value={v.min_practical_score}
              onChange={(e) => set("min_practical_score", e.target.value)} />
          </FormField>
          <FormField label="Minimum match threshold (0–100, 0 = none)" htmlFor="ep-minm" error={err.min_match_score}
            hint="Trainees whose match score is below this are not allocated. It is separate from each trainee's own match score and from evaluation scores.">
            <Input id="ep-minm" type="number" inputMode="decimal" min={0} max={100} step="1" value={v.min_match_score}
              onChange={(e) => set("min_match_score", e.target.value)} />
          </FormField>
          <FormField label="Project deadline override (IST)" htmlFor="ep-deadline" error={err.deadline}
            hint={`Leave empty to use the cycle deadline${p.deadline ? "" : ` (${formatIst(p.effective_deadline)})`}.`}>
            <div className="flex gap-2">
              <Input id="ep-deadline" type="datetime-local" value={v.deadline} onChange={(e) => set("deadline", e.target.value)} />
              {v.deadline && <Button variant="ghost" onClick={() => set("deadline", "")}>Clear</Button>}
            </div>
          </FormField>
          <div className="md:col-span-2">
            <FormField label="Prerequisite skills" htmlFor="ep-skills" error={err.skills}>
              <SkillsInput id="ep-skills" value={v.skills} onChange={(s) => set("skills", s)} />
            </FormField>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!dirty && <span className="text-sm text-muted">No changes</span>}
          <Button variant="secondary" disabled={!dirty || m.isPending} onClick={() => { setV(init); setFieldErrors({}); }}>Discard changes</Button>
          <Button type="submit" disabled={!dirty} loading={m.isPending}>Save changes</Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- document

function ReplaceDocumentCard({ project: p }: { project: Project }) {
  const toast = useToast();
  const refresh = useProjectInvalidate(p.id);
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [fileErr, setFileErr] = useState<string>();
  const [inputKey, setInputKey] = useState(0);
  const m = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append("file", file as File);
      setProgress(0);
      return sendMultipart<{ data: Project }>("PUT", `/projects/${p.id}/document`, form, { onProgress: setProgress }).finally(() => setProgress(null));
    },
    onSuccess: () => {
      toast.success("Document replaced; processing has restarted");
      setFile(null);
      setInputKey((k) => k + 1);
      refresh();
    },
    onError: (e) => setFileErr(documentError(e) ?? undefined),
  });
  return (
    <Card title={p.document || p.problem_doc_url ? "Replace document" : "Upload document"} icon={<FileArrowUp />}
      description="Uploading a new document re-runs processing. Edits you saved are kept where the new document does not change them.">
      <div className="flex flex-col gap-3">
        {p.document && <p className="text-sm text-muted">Current: <span className="font-medium text-text">{p.document.name}</span> ({formatBytes(p.document.size_bytes)})</p>}
        <FormField label="New document (PDF or DOCX, up to 10 MB)" htmlFor="rd-file">
          <FileField key={inputKey} id="rd-file" accept={DOC_ACCEPT} maxBytes={DOC_MAX} error={fileErr}
            onChange={(f) => { setFile(f); setFileErr(undefined); }} />
        </FormField>
        {progress != null && <UploadProgress value={progress} />}
        {m.error != null && !documentError(m.error) && <ApiErrorAlert error={m.error} />}
        <div className="flex justify-end">
          <Button icon={<UploadSimple />} disabled={!file} loading={m.isPending} onClick={() => m.mutate()}>Upload document</Button>
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- allocation controls

type Pending = "draft" | "published" | "archived" | "delete" | null;

function AllocationControls({ project: p }: { project: Project }) {
  const toast = useToast();
  const navigate = useNavigate();
  const refresh = useProjectInvalidate(p.id);
  const [pending, setPending] = useState<Pending>(null);
  const transition = useMutation({
    mutationFn: (to: "draft" | "published" | "archived") =>
      call(api.POST("/api/v1/projects/{project_id}/transition", { params: { path: { project_id: p.id } }, body: { to } })),
    onSuccess: (_res, to) => {
      toast.success(to === "published" ? "Allocation resumed" : to === "draft" ? "Allocation paused" : "Project archived");
      setPending(null);
      refresh();
    },
  });
  const del = useMutation({
    mutationFn: () => call(api.DELETE("/api/v1/projects/{project_id}", { params: { path: { project_id: p.id } } })),
    onSuccess: () => {
      toast.success(`Project ${p.project_code} deleted`);
      refresh();
      navigate(`/admin/projects?cycle=${p.cycle_id}`);
    },
  });
  const ready = p.processing_status === "ready";
  const resumeReason = !ready ? "Only ready projects can be offered to trainees" : undefined;
  const busy = transition.isPending || del.isPending;
  const confirm: Record<Exclude<Pending, null>, { title: string; message: string; label: string; danger?: boolean }> = {
    draft: { title: "Pause allocation?", message: "No new trainees will be allocated to this project. Trainees already working on it keep their allocation.", label: "Pause allocation" },
    published: { title: "Resume allocation?", message: "Automatic allocation will offer this project to eligible trainees on its next run.", label: "Resume allocation" },
    archived: { title: "Archive this project?", message: "The project stops being offered to trainees. Existing allocations, submissions and scores are kept.", label: "Archive project", danger: true },
    delete: { title: `Delete ${p.project_code}?`, message: "This permanently removes the project. It is only possible while no trainee has been allocated to it or submitted work.", label: "Delete project", danger: true },
  };
  const c = pending ? confirm[pending] : null;
  const error = pending === "delete" ? del.error : transition.error;
  return (
    <Card title="Allocation controls" icon={<Play />} description="Automatic allocation only offers ready projects that are open for allocation.">
      <div className="flex flex-col gap-3 text-sm">
        <p>
          Current state: <span className="font-semibold">{p.status === "published" ? "Open for allocation" : p.status === "archived" ? "Archived" : "Allocation paused"}</span>
        </p>
        <div className="flex flex-wrap gap-2">
          {p.status === "published" ? (
            <Button variant="secondary" icon={<Pause />} disabled={busy} onClick={() => setPending("draft")}>Pause allocation</Button>
          ) : (
            <Button variant="secondary" icon={<Play />} disabled={busy || !ready} title={resumeReason} onClick={() => setPending("published")}>Resume allocation</Button>
          )}
          {p.status !== "archived" && <Button variant="secondary" icon={<Archive />} disabled={busy} onClick={() => setPending("archived")}>Archive project</Button>}
          <Button variant="danger" icon={<Trash />} disabled={busy} onClick={() => setPending("delete")}>Delete</Button>
        </div>
        {p.status !== "published" && resumeReason && <p className="text-xs text-muted">{resumeReason}.</p>}
      </div>
      {c && (
        <ConfirmDialog open title={c.title} confirmLabel={c.label} danger={c.danger} loading={busy}
          message={<div className="flex flex-col gap-2"><p>{c.message}</p><ApiErrorAlert error={error} /></div>}
          onClose={() => { setPending(null); transition.reset(); del.reset(); }}
          onConfirm={() => (pending === "delete" ? del.mutate() : pending && transition.mutate(pending))} />
      )}
    </Card>
  );
}

