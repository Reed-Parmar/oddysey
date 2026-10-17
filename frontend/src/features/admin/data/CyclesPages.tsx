/** /admin/cycles and /admin/cycles/:cycleId (CYC-02..06, admin.md §3.9). */
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Archive, ArrowCounterClockwise, CalendarBlank, ChartBar, PaperPlaneTilt, PencilSimple, Plus, TreeStructure,
} from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { z } from "zod";

import { api, call } from "@/api/client";
import { ApiError } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Cycle } from "@/api/types";
import { useCurrentCycle } from "@/app/AppShell";
import {
  BackLink, ConfirmDialog, DataTable, DateTime, EmptyState, ErrorState, FormField, KeyValue, LoadingState, Meter,
  PageHeader, Pagination, StatusBadge, useToast, type Column,
} from "@/components/shared";
import { Alert, Button, Card, Dialog, Input } from "@/components/ui";
import { formatScore } from "@/lib/format";

import {
  ActionStack, ApiErrorAlert, CardState, FilterBar, LabeledSelect, ReadOnlyBanner, StatTile, StatusTrack, TableCard,
  TextLink, applyFieldErrors, fromLocalInput, toLocalInput, useInvalidate,
} from "./common";

const CYCLE_STAGES = [
  { key: "draft", label: "Planning" },
  { key: "published", label: "Allocations published" },
  { key: "archived", label: "Archived" },
];

/** `unchangedDeadline`: an existing (possibly past) deadline that is allowed when not edited. */
const makeCycleSchema = (unchangedDeadline?: string) => z.object({
  name: z.string().trim().min(1, "Name is required").max(120, "At most 120 characters"),
  submission_deadline: z.string().min(1, "Deadline is required")
    .refine((v) => v === unchangedDeadline || new Date(v).getTime() > Date.now(), "Deadline must be in the future"),
});
const cycleSchema = makeCycleSchema();
type CycleForm = z.infer<typeof cycleSchema>;

function useCycleInvalidate() {
  const inv = useInvalidate();
  return (transition = false) => {
    inv(qk.cycles.all(), qk.cycles.current(), qk.reports.all());
    if (transition) {
      inv(qk.allocations.all(), qk.progress.all(), qk.trainees.all(), qk.projects.all(), qk.submissions.all());
    }
  };
}

// ---------------------------------------------------------------- list

export function CyclesPage() {
  const [params, setParams] = useSearchParams();
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("-created_at");
  const [page, setPage] = useState(1);
  const current = useCurrentCycle();
  const active = current.data?.data ?? null;
  const createOpen = params.get("create") === "1";
  const setCreateOpen = (o: boolean) => setParams(o ? { create: "1" } : {}, { replace: true });
  const navigate = useNavigate();

  const query = { status: (status || undefined) as Cycle["status"] | undefined, sort, page, page_size: 20 };
  const list = useQuery({
    queryKey: qk.cycles.list(query),
    queryFn: () => call(api.GET("/api/v1/cycles", { params: { query } })),
  });

  const createReason = active ? `Archive ${active.name} before creating a new cycle` : undefined;
  const cols: Column<Cycle>[] = [
    { key: "name", header: "Name", sort: "name", className: "min-w-48", cell: (c) => (
      <span className="flex flex-wrap items-center gap-2">
        <Link className="font-semibold text-text hover:text-primary hover:underline" to={`/admin/cycles/${c.id}`}>{c.name}</Link>
        {c.id === active?.id && <span className="rounded-md bg-primary-soft px-1.5 py-0.5 text-xs font-semibold text-primary-ink">Active</span>}
      </span>
    ) },
    { key: "status", header: "Status", cell: (c) => <StatusBadge kind="cycle" value={c.status} /> },
    { key: "deadline", header: "Submission deadline", cell: (c) => <span className="whitespace-nowrap"><DateTime value={c.submission_deadline} /></span> },
    { key: "created", header: "Created", sort: "-created_at", cell: (c) => <span className="whitespace-nowrap text-muted"><DateTime value={c.created_at} dateOnly /></span> },
  ];

  return (
    <div>
      <PageHeader title="Cycles" description="A cycle moves from Planning to Allocations published to Archived. Only one cycle can be active."
        actions={<ActionStack reason={createReason}>
          <Button icon={<Plus />} disabled={!!createReason || current.isLoading} onClick={() => setCreateOpen(true)}>New cycle</Button>
        </ActionStack>} />
      <TableCard title="All cycles" icon={<TreeStructure />}
        description={list.data ? `${list.data.meta.total} ${list.data.meta.total === 1 ? "cycle" : "cycles"}` : undefined}
        toolbar={<FilterBar>
          <LabeledSelect id="cycle-status" label="Status" value={status} onChange={(v) => { setStatus(v); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="draft">Planning</option>
            <option value="published">Allocations published</option>
            <option value="archived">Archived</option>
          </LabeledSelect>
        </FilterBar>}
        footer={list.data?.data.length ? <Pagination meta={list.data.meta} onPageChange={setPage} /> : undefined}>
        {list.isLoading ? <CardState><LoadingState /></CardState> : list.error ? <CardState><ErrorState error={list.error} onRetry={() => list.refetch()} /></CardState> :
          !list.data?.data.length ? (
            <CardState>
              <EmptyState icon={<TreeStructure />} title={status ? "No cycles with this status" : "No cycles yet"}
                description={status ? undefined : "Create your first cycle to start importing trainees and projects."}
                action={!status && !createReason ? <Button icon={<Plus />} onClick={() => setCreateOpen(true)}>Create your first cycle</Button> : undefined} />
            </CardState>
          ) : (
            <DataTable rows={list.data.data} columns={cols} rowKey={(c) => c.id} sort={sort}
              onSortChange={(s) => { setSort(s); setPage(1); }} onRowClick={(c) => navigate(`/admin/cycles/${c.id}`)} caption="Cycles" />
          )}
      </TableCard>
      <CreateCycleDialog open={createOpen && !createReason} onClose={() => setCreateOpen(false)} />
    </div>
  );
}

function CreateCycleDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useCycleInvalidate();
  const form = useForm<CycleForm>({ resolver: zodResolver(cycleSchema), defaultValues: { name: "", submission_deadline: "" } });
  const [alertError, setAlertError] = useState<unknown>(null);
  const m = useMutation({
    onMutate: () => setAlertError(null),
    mutationFn: (v: CycleForm) => call(api.POST("/api/v1/cycles", {
      body: { name: v.name.trim(), submission_deadline: fromLocalInput(v.submission_deadline) },
    })),
    onSuccess: (res) => {
      invalidate();
      toast.success(`Cycle "${res.data.name}" created`);
      form.reset();
      onClose();
      navigate(`/admin/cycles/${res.data.id}`);
    },
    onError: (e) => {
      if (!applyFieldErrors(e, form.setError, ["name", "submission_deadline"], { DUPLICATE_NAME: "name" })) setAlertError(e);
    },
  });
  const close = () => { setAlertError(null); m.reset(); onClose(); };
  return (
    <Dialog open={open} onClose={close} title="New cycle" description="A cycle holds one programme round: trainees, projects, recommendations and allocations." footer={<>
      <Button variant="secondary" onClick={close}>Cancel</Button>
      <Button type="submit" form="create-cycle" loading={m.isPending}>Create cycle</Button>
    </>}>
      <form id="create-cycle" className="flex flex-col gap-3" noValidate onSubmit={form.handleSubmit((v) => m.mutate(v))}>
        {alertError instanceof ApiError && alertError.code === "ACTIVE_CYCLE_EXISTS"
          ? <Alert variant="danger" icon={<Archive />}>Archive the current cycle first. <Link className="font-semibold underline" to="/admin/cycles" onClick={close}>View cycles</Link></Alert>
          : <ApiErrorAlert error={alertError} />}
        <FormField label="Name" htmlFor="cycle-name" required error={form.formState.errors.name?.message}>
          <Input id="cycle-name" maxLength={120} placeholder="Oct 2026 CSR Projects" {...form.register("name")} />
        </FormField>
        <FormField label="Submission deadline" htmlFor="cycle-deadline" required error={form.formState.errors.submission_deadline?.message}
          hint="Your local time. Late flags are computed against this deadline.">
          <Input id="cycle-deadline" type="datetime-local" {...form.register("submission_deadline")} />
        </FormField>
      </form>
    </Dialog>
  );
}

// ---------------------------------------------------------------- detail

type Target = "draft" | "published" | "archived";
const T_ICON: Record<Target, ReactNode> = { published: <PaperPlaneTilt />, draft: <ArrowCounterClockwise />, archived: <Archive /> };
const TRANSITIONS: Record<Cycle["status"], { to: Target; label: string; confirm: string; danger?: boolean }[]> = {
  draft: [
    { to: "published", label: "Publish allocations", confirm: "Students and supervisors will see their allocations. Continue?" },
    { to: "archived", label: "Archive / discard", confirm: "Archiving is irreversible: the cycle becomes read-only and cannot be reactivated.", danger: true },
  ],
  published: [
    { to: "draft", label: "Return to planning", confirm: "Allocations will be hidden from students and supervisors again. This is blocked once any submission exists." },
    { to: "archived", label: "Archive", confirm: "Archiving is irreversible: the cycle becomes read-only and cannot be reactivated.", danger: true },
  ],
  archived: [],
};

export function CycleDetailPage() {
  const { cycleId = "" } = useParams();
  const q = useQuery({
    queryKey: qk.cycles.detail(cycleId),
    queryFn: () => call(api.GET("/api/v1/cycles/{cycle_id}", { params: { path: { cycle_id: cycleId } } })),
  });
  if (q.isLoading) return <LoadingState />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const c = q.data.data;
  return (
    <div className="space-y-6">
      <PageHeader title={c.name} eyebrow={<BackLink to="/admin/cycles">All cycles</BackLink>}
        description={<span className="inline-flex items-center gap-1.5"><CalendarBlank aria-hidden size={16} />Submissions due <DateTime value={c.submission_deadline} /></span>}
        actions={<StatusBadge kind="cycle" value={c.status} />} />
      {c.status === "archived" && <ReadOnlyBanner />}
      <CycleTransitions cycle={c} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <CycleSummary cycleId={c.id} />
        <CycleEditForm key={c.updated_at} cycle={c} />
      </div>
    </div>
  );
}

function CycleTransitions({ cycle }: { cycle: Cycle }) {
  const toast = useToast();
  const invalidate = useCycleInvalidate();
  const [pending, setPending] = useState<(typeof TRANSITIONS)["draft"][number] | null>(null);
  const m = useMutation({
    mutationFn: (to: Target) => call(api.POST("/api/v1/cycles/{cycle_id}/transition", { params: { path: { cycle_id: cycle.id } }, body: { to } })),
    onSuccess: (res) => {
      invalidate(true);
      setPending(null);
      toast.success(`Cycle is now: ${res.data.status === "draft" ? "Planning" : res.data.status === "published" ? "Allocations published" : "Archived"}`);
    },
    onError: () => setPending(null),
  });
  const options = TRANSITIONS[cycle.status];
  return (
    <Card title="Lifecycle" icon={<TreeStructure />} description="Each change asks for confirmation. Archiving cannot be undone.">
      <div className="flex flex-col gap-4">
        <StatusTrack stages={CYCLE_STAGES} current={cycle.status} linear />
        {options.length === 0 ? <p className="text-sm text-muted">Archived cycles cannot change state.</p> : (
          <div className="flex flex-col gap-3 border-t border-border pt-4">
            <div className="flex flex-wrap gap-2">
              {options.map((o) => (
                <Button key={o.to} icon={T_ICON[o.to]} variant={o.danger ? "danger" : o.to === "published" ? "primary" : "secondary"}
                  disabled={m.isPending} onClick={() => { m.reset(); setPending(o); }}>{o.label}</Button>
              ))}
            </div>
            {cycle.status === "draft" && <p className="text-xs text-muted">Publishing needs at least one allocation and no recommendation run in progress. Review them on <TextLink to="/admin/allocations">Allocations</TextLink>.</p>}
            <ApiErrorAlert error={m.error} />
          </div>
        )}
      </div>
      <ConfirmDialog open={!!pending} title={pending?.label ?? ""} message={pending?.confirm ?? ""} danger={pending?.danger}
        confirmLabel={pending?.label} loading={m.isPending} onClose={() => setPending(null)}
        onConfirm={() => pending && m.mutate(pending.to)} />
    </Card>
  );
}

function CycleSummary({ cycleId }: { cycleId: string }) {
  const q = useQuery({
    queryKey: qk.reports.overview(cycleId),
    queryFn: () => call(api.GET("/api/v1/admin/reports/overview", { params: { query: { cycle_id: cycleId } } })),
  });
  if (q.isLoading) return <LoadingState label="Loading summary…" />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const o = q.data.data;
  const allocated = o.allocation?.allocated ?? 0;
  const totalTrainees = allocated + (o.allocation?.unallocated ?? 0);
  return (
    <Card title="Summary" icon={<ChartBar />} actions={<TextLink to="/admin">Full overview</TextLink>}>
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Meter label="Trainees allocated" value={allocated} max={totalTrainees} tone="success" />
          <Meter label="Capacity used" value={o.allocation?.capacity_used ?? 0} max={o.allocation?.capacity_total ?? 0} />
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <StatTile label="Trainees" value={o.trainees?.total ?? 0} hint={`${o.trainees?.assessment_pending ?? 0} assessment pending`} />
          <StatTile label="Allocated" value={allocated} hint={`${o.allocation?.unallocated ?? 0} unallocated`} />
          <StatTile label="Capacity used" value={`${o.allocation?.capacity_used ?? 0} / ${o.allocation?.capacity_total ?? 0}`} />
          <StatTile label="Average match" value={formatScore(o.allocation?.average_match_score)} />
          <StatTile label="Submitted" value={(o.submissions?.submitted ?? 0) + (o.submissions?.evaluated ?? 0) + (o.submissions?.rework_requested ?? 0)}
            hint={`${o.submissions?.not_submitted ?? 0} not submitted`} tone="info" />
          <StatTile label="Evaluated" value={o.submissions?.evaluated ?? 0} tone="success" />
          <StatTile label="Late" value={o.submissions?.late ?? 0} tone={o.submissions?.late ? "warning" : undefined} />
          <StatTile label="Overrides" value={o.allocation?.overrides ?? 0} tone={o.allocation?.overrides ? "warning" : undefined} />
        </div>
      </div>
    </Card>
  );
}

function CycleEditForm({ cycle }: { cycle: Cycle }) {
  const toast = useToast();
  const invalidate = useCycleInvalidate();
  const readOnly = cycle.status === "archived";
  const form = useForm<CycleForm>({
    resolver: zodResolver(makeCycleSchema(toLocalInput(cycle.submission_deadline))),
    defaultValues: { name: cycle.name, submission_deadline: toLocalInput(cycle.submission_deadline) },
  });
  const [alertError, setAlertError] = useState<unknown>(null);
  const m = useMutation({
    onMutate: () => setAlertError(null),
    mutationFn: (v: CycleForm) => {
      const body: { name?: string; submission_deadline?: string } = {};
      if (v.name.trim() !== cycle.name) body.name = v.name.trim();
      if (v.submission_deadline !== toLocalInput(cycle.submission_deadline)) body.submission_deadline = fromLocalInput(v.submission_deadline);
      return call(api.PATCH("/api/v1/cycles/{cycle_id}", { params: { path: { cycle_id: cycle.id } }, body }));
    },
    onSuccess: () => {
      invalidate();
      toast.success("Cycle saved");
    },
    onError: (e) => {
      if (!applyFieldErrors(e, form.setError, ["name", "submission_deadline"], { DUPLICATE_NAME: "name" })) setAlertError(e);
    },
  });
  const dirty = form.formState.isDirty;
  return (
    <Card title="Details" icon={<PencilSimple />}>
      {readOnly && <p className="mb-3 text-xs text-muted">Cycle is archived (read-only).</p>}
      <form className="flex flex-col gap-4" noValidate onSubmit={form.handleSubmit((v) => m.mutate(v))}>
        <ApiErrorAlert error={alertError} />
        <FormField label="Name" htmlFor="edit-cycle-name" required error={form.formState.errors.name?.message}>
          <Input id="edit-cycle-name" maxLength={120} disabled={readOnly} {...form.register("name")} />
        </FormField>
        <FormField label="Submission deadline" htmlFor="edit-cycle-deadline" required error={form.formState.errors.submission_deadline?.message}
          hint="Late flags are computed against this deadline. Your local time.">
          <Input id="edit-cycle-deadline" type="datetime-local" disabled={readOnly} {...form.register("submission_deadline")} />
        </FormField>
        <div className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
          <KeyValue items={[["Created", <DateTime key="c" value={cycle.created_at} />], ["Last updated", <DateTime key="u" value={cycle.updated_at} />]]} />
        </div>
        <div className="border-t border-border pt-4">
          <Button type="submit" loading={m.isPending} disabled={readOnly || !dirty}>Save changes</Button>
        </div>
      </form>
    </Card>
  );
}
