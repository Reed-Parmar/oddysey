/** /admin overview: cycle management (create, settings, archive, history) + programme stats + automation (ADR-017). */
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Archive, ArrowClockwise, CalendarPlus, ChartBar, CheckCircle, ClockCounterClockwise, FolderSimple, GearSix, GraduationCap,
  Info, Lightning, Robot, Target, Users, Warning,
} from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";
import { z } from "zod";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { Automation, Cycle, Overview } from "@/api/types";
import { useCurrentCycle } from "@/app/AppShell";
import {
  DataTable, EmptyState, ErrorState, FormField, LoadingState, Meter, PageHeader, StackedBar, StatCard, StatusBadge,
  useToast, type Column,
} from "@/components/shared";
import { Alert, Button, Card, Dialog, Input, Textarea } from "@/components/ui";
import { formatScore } from "@/lib/format";
import { label } from "@/lib/statusLabels";

import {
  ApiErrorAlert, IstDateTime, MetaLine, StatTile, applyFieldErrors, formatIst, fromLocalInput, humanize, toLocalInput,
  triggerLabel, useAllCycles, useInvalidate,
} from "./common";

const GRADE_ORDER = ["A1", "A", "B+", "B", "C", "D"] as const;
const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—");

const ARCHIVE_EXPLANATION =
  "Archiving closes a completed cohort while keeping every assignment, document, submission, score, originality report and audit record. It freezes outcomes and keeps completed work out of new allocation runs. It is not deletion or a backup. Only one cycle can be active, so archiving also makes room for the next cohort. Scheduled archiving runs automatically at the archive date when enabled.";

export function AdminOverview() {
  const current = useCurrentCycle();
  const [viewId, setViewId] = useState<string | null>(null);
  const active = current.data?.data ?? null;

  if (current.isLoading) return <><PageHeader title="Overview" eyebrow="Programme team" /><LoadingState /></>;
  if (current.error) return <><PageHeader title="Overview" eyebrow="Programme team" /><ErrorState error={current.error} onRetry={() => void current.refetch()} /></>;

  const viewingPast = viewId != null && viewId !== active?.id;
  return (
    <div className="space-y-6">
      {viewingPast ? (
        <PastCycleView cycleId={viewId} onBack={() => setViewId(null)} />
      ) : active ? (
        <ActiveCycleView cycle={active} />
      ) : (
        <>
          <PageHeader title="Overview" eyebrow="Programme team"
            description="There is no active cycle. Create one to start the next cohort; projects, trainee enrolment and automatic allocation all happen inside it." />
          <CreateCycleCard />
        </>
      )}
      <CycleHistory activeId={active?.id} viewingId={viewingPast ? viewId : active?.id ?? null} onView={(id) => setViewId(id)} />
    </div>
  );
}

// ---------------------------------------------------------------- active cycle

function ActiveCycleView({ cycle }: { cycle: Cycle }) {
  const [archiveOpen, setArchiveOpen] = useState(false);
  const report = useOverview(cycle.id);
  return (
    <>
      <PageHeader title={cycle.name} eyebrow="Overview · active cycle"
        description={<MetaLine items={[
          <StatusBadge key="s" kind="cycle" value={cycle.status} />,
          <span key="d">Submission deadline <IstDateTime value={cycle.submission_deadline} /></span>,
          <span key="a">Archive {cycle.archive_at ? <IstDateTime value={cycle.archive_at} /> : "date not set"} · scheduled archiving {cycle.auto_archive_enabled ? "on" : "off"}</span>,
        ]} />}
        actions={<Button variant="secondary" icon={<Archive />} onClick={() => setArchiveOpen(true)}>Archive cycle</Button>} />
      {report.isLoading ? <LoadingState /> : report.error ? <ErrorState error={report.error} onRetry={() => void report.refetch()} /> : report.data ? (
        <OverviewStats o={report.data.data} />
      ) : null}
      <div className="grid gap-6 xl:grid-cols-2">
        <AutomationCard />
        <CycleSettingsCard cycle={cycle} />
      </div>
      <ArchiveDialog cycle={cycle} open={archiveOpen} onClose={() => setArchiveOpen(false)} />
    </>
  );
}

function useOverview(cycleId: string) {
  return useQuery({
    queryKey: qk.reports.overview(cycleId),
    queryFn: () => call(api.GET("/api/v1/admin/reports/overview", { params: { query: { cycle_id: cycleId } } })),
  });
}

// ---------------------------------------------------------------- past cycle (read-only)

function PastCycleView({ cycleId, onBack }: { cycleId: string; onBack: () => void }) {
  const cycles = useAllCycles();
  const cycle = cycles.data?.data.find((c) => c.id === cycleId);
  const report = useOverview(cycleId);
  return (
    <>
      <PageHeader title={cycle?.name ?? "Past cycle"} eyebrow="Overview · cycle history"
        description={cycle ? <MetaLine items={[
          <StatusBadge key="s" kind="cycle" value={cycle.status} />,
          <span key="d">Deadline <IstDateTime value={cycle.submission_deadline} /></span>,
          cycle.archived_at ? <span key="a">Archived <IstDateTime value={cycle.archived_at} /></span> : null,
        ]} /> : undefined}
        actions={<Button variant="secondary" onClick={onBack}>Back to the current overview</Button>} />
      <Alert variant="info" icon={<Info />} title={cycle?.status === "archived" ? "Archived (read-only)" : "Read-only view"}>
        Outcomes of this cycle are frozen. Every assignment, submission, score and report is kept.
        {cycle?.archive_reason && <span className="mt-1 block">Archive reason: {cycle.archive_reason}</span>}
      </Alert>
      {report.isLoading ? <LoadingState /> : report.error ? <ErrorState error={report.error} onRetry={() => void report.refetch()} /> : report.data ? (
        <OverviewStats o={report.data.data} />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------- stats

function OverviewStats({ o }: { o: Overview }) {
  const t = o.trainees;
  const p = o.projects;
  const a = o.allocation;
  const s = o.submissions;
  const total = a ? a.assigned + a.unassigned : 0;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Trainees" value={t?.total ?? 0} icon={<GraduationCap />} to="/admin/tracking"
          hint={t ? `${t.assessment_complete} assessed · ${t.profile_only} profile only` : undefined} />
        <StatCard label="Projects ready" value={p?.ready ?? 0} icon={<FolderSimple />} tone="accent" to="/admin/projects"
          hint={p ? `${p.total} in total · ${p.working_individually} trainees working individually` : undefined} />
        <StatCard label="Assigned" value={a?.assigned ?? 0} icon={<Target />} tone="success" to="/admin/tracking"
          hint={a ? `Coverage ${pct(a.assigned, total)} · ${a.unassigned} waiting` : undefined} />
        <StatCard label="Evaluated" value={s?.evaluated ?? 0} icon={<CheckCircle />} to="/admin/tracking"
          hint={s ? `${s.submitted} awaiting evaluation · ${s.not_submitted} not submitted` : undefined} />
      </div>

      <div className="grid gap-6 xl:grid-cols-2">
        <Card title="Matching status" icon={<Target />} description="Automatic allocation: each trainee works individually on one project.">
          {a ? (
            <div className="flex flex-col gap-4">
              <Meter label="Trainees assigned" value={a.assigned} max={total} tone="success"
                valueLabel={`${a.assigned} / ${total} (${pct(a.assigned, total)})`} />
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <StatTileDl label="Unassigned" value={a.unassigned} tone={a.unassigned ? "warning" : "neutral"} />
                <StatTileDl label="Average match" value={a.average_match_score == null ? "—" : `${formatScore(a.average_match_score)} / 100`} />
                <StatTileDl label="Rejections" value={a.rejections_total} />
                <StatTileDl label="Replacements pending" value={a.pending_replacements} tone={a.pending_replacements ? "warning" : "neutral"} />
                <StatTileDl label="Replacements completed" value={a.completed_replacements} tone="success" />
              </dl>
              <CountList title="By match mode" entries={a.by_mode} format={(k) => label("matchMode", k)[0]} />
              <CountList title="By allocation source" entries={a.by_trigger} format={triggerLabel} />
            </div>
          ) : <p className="text-sm text-muted">No allocation data for this cycle yet.</p>}
        </Card>

        <Card title="Trainees and projects" icon={<GraduationCap />}>
          <div className="flex flex-col gap-4">
            {t ? (
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <StatTileDl label="Total trainees" value={t.total} />
                <StatTileDl label="Assessed (verified marks)" value={t.assessment_complete} tone="success" />
                <StatTileDl label="Profile only" value={t.profile_only} />
                <StatTileDl label="Self-registered" value={t.self_registered} />
                <StatTileDl label="Linked accounts" value={t.linked_accounts} />
              </dl>
            ) : <p className="text-sm text-muted">No trainees enrolled yet.</p>}
            {p && p.total > 0 ? (
              <div>
                <h3 className="mb-2 text-sm font-semibold">Project processing ({p.total})</h3>
                <StackedBar label="Projects by processing status"
                  segments={Object.entries(p.by_processing).map(([k, v]) => ({ label: label("processing", k)[0], value: v }))} />
              </div>
            ) : <p className="text-sm text-muted">No projects yet. Create or import projects from the Projects page.</p>}
            {t && t.by_trade.length > 0 && (
              <div>
                <h3 className="mb-2 text-sm font-semibold">Trainees by trade</h3>
                <ul className="flex flex-wrap gap-1.5">
                  {t.by_trade.map((x) => (
                    <li key={x.trade_id} className="rounded-md border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium">
                      {x.name} <span className="font-semibold tabular-nums">{x.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Card>

        <Card title="Submissions" icon={<ChartBar />}>
          {s ? (
            <div className="flex flex-col gap-4">
              <StackedBar label="Submissions by status" segments={[
                { label: "Not submitted", value: s.not_submitted, className: "bg-subtle" },
                { label: "Awaiting evaluation", value: s.submitted, className: "bg-info" },
                { label: "Rework requested", value: s.rework_requested, className: "bg-warning" },
                { label: "Evaluated", value: s.evaluated, className: "bg-success" },
              ]} />
              <p className="text-sm text-muted">{s.late} late submission{s.late === 1 ? "" : "s"}.</p>
              <CountList title="Report analysis" entries={s.by_analysis} format={(k) => label("analysis", k)[0]} />
            </div>
          ) : <p className="text-sm text-muted">No submissions yet.</p>}
        </Card>

        <Card title="Grades" icon={<CheckCircle />} description="Latest evaluated version per trainee.">
          {o.grades && Object.values(o.grades).some((n) => n > 0) ? (
            <StackedBar label="Grade distribution" segments={GRADE_ORDER.map((g) => ({ label: g, value: o.grades?.[g] ?? 0 }))} />
          ) : <p className="text-sm text-muted">No grades yet.</p>}
        </Card>
      </div>

      <Card title="Users" icon={<Users />}>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          <StatTileDl label="Students" value={o.users.students} />
          <StatTileDl label="Supervisors" value={o.users.supervisors} />
          <StatTileDl label="Admins" value={o.users.admins} />
          <StatTileDl label="Disabled" value={o.users.disabled} />
          <StatTileDl label="Pending invitations" value={o.users.pending_invitations} />
        </dl>
      </Card>
    </div>
  );
}

function StatTileDl(props: { label: string; value: ReactNode; tone?: "neutral" | "success" | "warning" }) {
  return <div><StatTile {...props} /></div>;
}

function CountList({ title, entries, format }: { title: string; entries: Record<string, number>; format: (k: string) => string }) {
  const items = Object.entries(entries).filter(([, n]) => n > 0);
  return (
    <div>
      <h3 className="mb-1.5 text-sm font-semibold">{title}</h3>
      {items.length ? (
        <ul className="flex flex-wrap gap-1.5">
          {items.map(([k, n]) => (
            <li key={k} className="rounded-md border border-border bg-surface-2 px-2 py-0.5 text-xs font-medium">
              {format(k)} <span className="font-semibold tabular-nums">{n}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm text-muted">None yet.</p>}
    </div>
  );
}

// ---------------------------------------------------------------- automation

function lastResult(a: Automation) {
  const r = (a.last_allocation_result ?? {}) as { allocated?: number; waiting?: number; replacements?: number; ready_projects?: number };
  return r;
}

function AutomationCard() {
  const toast = useToast();
  const invalidate = useInvalidate();
  const q = useQuery({
    queryKey: qk.automation.status(),
    queryFn: () => call(api.GET("/api/v1/admin/automation")),
    refetchInterval: 30_000,
  });
  const run = useMutation({
    mutationFn: () => call(api.POST("/api/v1/admin/automation/run-now")),
    onSuccess: () => {
      toast.success("Allocation run queued");
      invalidate(qk.automation.status(), qk.reports.all(), qk.progress.all(), qk.allocations.all(), qk.projects.all());
    },
  });
  const a = q.data?.data;
  const r = a ? lastResult(a) : {};
  return (
    <Card title="Automation" icon={<Robot />}
      description="Allocation runs on a schedule in the background; no approval step is needed."
      actions={<Button size="sm" variant="secondary" icon={<Lightning />} loading={run.isPending} disabled={!a} onClick={() => run.mutate()}>Run allocation now</Button>}>
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : a ? (
        <div className="flex flex-col gap-4 text-sm">
          <ApiErrorAlert error={run.error} />
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StatTileDl label="Runs every" value={`${a.interval_minutes} min`} />
            <StatTileDl label="Queued jobs" value={a.queued_jobs} />
            <StatTileDl label="Failed jobs (24 h)" value={a.failed_jobs_24h} tone={a.failed_jobs_24h ? "warning" : "neutral"} />
          </dl>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]">
            <dt className="text-muted">Last allocation run</dt>
            <dd className="font-medium">
              {a.last_allocation_at ? formatIst(a.last_allocation_at) : "Not run yet"}
              {a.last_allocation_result && (
                <span className="block text-xs font-normal text-muted">
                  {r.allocated ?? 0} allocated · {r.waiting ?? 0} waiting{r.replacements != null && ` · ${r.replacements} replacements`}
                  {r.ready_projects != null && ` · ${r.ready_projects} ready projects`}
                </span>
              )}
            </dd>
            <dt className="text-muted">Next run (estimate)</dt>
            <dd className="font-medium">{a.next_allocation_estimate ? formatIst(a.next_allocation_estimate) : "—"}</dd>
            <dt className="text-muted">Email delivery</dt>
            <dd className="font-medium">{a.email_backend === "disabled" ? "Not configured (in-app notifications only)" : humanize(a.email_backend)}</dd>
            <dt className="text-muted">AI</dt>
            <dd className="font-medium">{a.ai_configured ? "Configured" : "Not configured (rule-based fallbacks are used)"}</dd>
          </dl>
          <p className="text-xs text-muted">
            "Run allocation now" is optional: it only queues the same job early. The schedule keeps running automatically.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

// ---------------------------------------------------------------- create cycle

const createSchema = z.object({
  name: z.string().trim().min(1, "Enter a name").max(120, "120 characters at most"),
  submission_deadline: z.string().min(1, "Choose the submission deadline"),
  archive_at: z.string(),
  auto_archive_enabled: z.boolean(),
}).refine((v) => !v.archive_at || !v.submission_deadline || v.archive_at > v.submission_deadline, {
  path: ["archive_at"], message: "The archive date must be after the submission deadline",
});
type CreateForm = z.infer<typeof createSchema>;

function CreateCycleCard() {
  const toast = useToast();
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [alertError, setAlertError] = useState<unknown>(null);
  const form = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: { name: "", submission_deadline: "", archive_at: "", auto_archive_enabled: true },
  });
  const m = useMutation({
    onMutate: () => setAlertError(null),
    mutationFn: (v: CreateForm) => call(api.POST("/api/v1/cycles", { body: {
      name: v.name.trim(),
      submission_deadline: fromLocalInput(v.submission_deadline),
      archive_at: v.archive_at ? fromLocalInput(v.archive_at) : null,
      auto_archive_enabled: v.auto_archive_enabled,
      archive_timezone: "Asia/Kolkata",
    } })),
    onSuccess: (res) => {
      invalidate(qk.cycles.all(), qk.reports.all(), qk.automation.status(), qk.progress.all());
      toast.success(`Cycle "${res.data.name}" created`);
      navigate(`/admin/projects?cycle=${res.data.id}`);
    },
    onError: (e) => {
      if (!applyFieldErrors(e, form.setError, ["name", "submission_deadline", "archive_at"])) setAlertError(e);
    },
  });
  const err = form.formState.errors;
  return (
    <Card title="Create cycle" icon={<CalendarPlus />} description="A cycle is one cohort round. Times are in India Standard Time (Asia/Kolkata).">
      <form noValidate className="flex flex-col gap-4" onSubmit={form.handleSubmit((v) => m.mutate(v))}>
        <ApiErrorAlert error={alertError} />
        <div className="grid gap-4 md:grid-cols-2">
          <FormField label="Name" htmlFor="cy-name" required error={err.name?.message}>
            <Input id="cy-name" maxLength={120} placeholder="e.g. ITI cohort Oct 2026" {...form.register("name")} />
          </FormField>
          <FormField label="Submission deadline (IST)" htmlFor="cy-deadline" required error={err.submission_deadline?.message}>
            <Input id="cy-deadline" type="datetime-local" {...form.register("submission_deadline")} />
          </FormField>
          <FormField label="Archive date (IST, optional)" htmlFor="cy-archive" error={err.archive_at?.message}
            hint="Defaults to 7 days after the deadline.">
            <Input id="cy-archive" type="datetime-local" {...form.register("archive_at")} />
          </FormField>
          <div className="flex flex-col justify-end">
            <label className="inline-flex min-h-11 items-center gap-2.5 text-sm font-medium">
              <input type="checkbox" className="size-4 accent-primary" {...form.register("auto_archive_enabled")} />
              Archive automatically at the archive date
            </label>
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="submit" icon={<CalendarPlus />} loading={m.isPending}>Create cycle</Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- settings

function CycleSettingsCard({ cycle }: { cycle: Cycle }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const initial = {
    submission_deadline: toLocalInput(cycle.submission_deadline),
    archive_at: toLocalInput(cycle.archive_at),
    auto_archive_enabled: cycle.auto_archive_enabled,
  };
  const [v, setV] = useState(initial);
  const [syncedFrom, setSyncedFrom] = useState(cycle.updated_at);
  if (syncedFrom !== cycle.updated_at) {
    setSyncedFrom(cycle.updated_at);
    setV(initial);
  }
  const body: { submission_deadline?: string; archive_at?: string | null; auto_archive_enabled?: boolean } = {};
  if (v.submission_deadline && v.submission_deadline !== initial.submission_deadline) body.submission_deadline = fromLocalInput(v.submission_deadline);
  if (v.archive_at !== initial.archive_at) body.archive_at = v.archive_at ? fromLocalInput(v.archive_at) : null;
  if (v.auto_archive_enabled !== initial.auto_archive_enabled) body.auto_archive_enabled = v.auto_archive_enabled;
  const dirty = Object.keys(body).length > 0;
  const orderError = v.archive_at && v.submission_deadline && v.archive_at <= v.submission_deadline
    ? "The archive date must be after the submission deadline" : undefined;
  const m = useMutation({
    mutationFn: () => call(api.PATCH("/api/v1/cycles/{cycle_id}", { params: { path: { cycle_id: cycle.id } }, body })),
    onSuccess: () => {
      invalidate(qk.cycles.all(), qk.reports.all(), qk.projects.all(), qk.progress.all());
      toast.success("Cycle settings saved");
    },
  });
  return (
    <Card title="Cycle settings" icon={<GearSix />} description="Times are in India Standard Time (Asia/Kolkata). Project deadlines without an override follow the cycle deadline.">
      <form noValidate className="flex flex-col gap-4" onSubmit={(e) => { e.preventDefault(); if (dirty && !orderError) m.mutate(); }}>
        <ApiErrorAlert error={m.error} />
        <FormField label="Submission deadline (IST)" htmlFor="cs-deadline" required>
          <Input id="cs-deadline" type="datetime-local" value={v.submission_deadline}
            onChange={(e) => setV({ ...v, submission_deadline: e.target.value })} />
        </FormField>
        <FormField label="Archive date (IST)" htmlFor="cs-archive" error={orderError} hint="Leave empty to clear it.">
          <Input id="cs-archive" type="datetime-local" value={v.archive_at} onChange={(e) => setV({ ...v, archive_at: e.target.value })} />
        </FormField>
        <label className="inline-flex items-center gap-2.5 text-sm font-medium">
          <input type="checkbox" className="size-4 accent-primary" checked={v.auto_archive_enabled}
            onChange={(e) => setV({ ...v, auto_archive_enabled: e.target.checked })} />
          Archive automatically at the archive date
        </label>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={!dirty || m.isPending} onClick={() => setV(initial)}>Reset</Button>
          <Button type="submit" disabled={!dirty || !!orderError} loading={m.isPending}>Save settings</Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- archive

function ArchiveDialog({ cycle, open, onClose }: { cycle: Cycle; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const preview = useQuery({
    queryKey: qk.cycles.archivePreview(cycle.id),
    queryFn: () => call(api.GET("/api/v1/cycles/{cycle_id}/archive-preview", { params: { path: { cycle_id: cycle.id } } })),
    enabled: open,
  });
  const m = useMutation({
    mutationFn: () => call(api.POST("/api/v1/cycles/{cycle_id}/archive", {
      params: { path: { cycle_id: cycle.id } }, body: { reason: reason.trim(), confirm: true },
    })),
    onSuccess: () => {
      invalidate(qk.cycles.all(), qk.reports.all(), qk.projects.all(), qk.progress.all(), qk.allocations.all(), qk.automation.status());
      toast.success(`Cycle "${cycle.name}" archived`);
      close();
    },
  });
  function close() {
    setReason("");
    setConfirmed(false);
    m.reset();
    onClose();
  }
  const p = preview.data?.data;
  const tooShort = reason.trim().length < 5;
  return (
    <Dialog open={open} onClose={m.isPending ? () => {} : close} title={`Archive ${cycle.name}?`} size="lg" footer={<>
      <Button variant="secondary" onClick={close} disabled={m.isPending}>Cancel</Button>
      <Button variant="danger" icon={<Archive />} loading={m.isPending} disabled={tooShort || !confirmed || !p} onClick={() => m.mutate()}>Archive cycle</Button>
    </>}>
      <div className="flex flex-col gap-4 text-sm">
        <Alert variant="info" icon={<Info />}>{ARCHIVE_EXPLANATION}</Alert>
        {preview.isLoading ? <LoadingState label="Loading impact preview…" /> : preview.error ? (
          <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
        ) : p ? (
          <div>
            <h3 className="mb-2 font-semibold">What is still open in this cycle</h3>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatTileDl label="Active allocations" value={p.active_allocations} />
              <StatTileDl label="Without a submission" value={p.allocations_without_submission} tone={p.allocations_without_submission ? "warning" : "neutral"} />
              <StatTileDl label="Awaiting analysis" value={p.submissions_awaiting_analysis} tone={p.submissions_awaiting_analysis ? "warning" : "neutral"} />
              <StatTileDl label="Awaiting evaluation" value={p.submissions_awaiting_evaluation} tone={p.submissions_awaiting_evaluation ? "warning" : "neutral"} />
              <StatTileDl label="Rework requested" value={p.rework_requested} tone={p.rework_requested ? "warning" : "neutral"} />
              <StatTileDl label="Pending replacements" value={p.pending_replacements} tone={p.pending_replacements ? "warning" : "neutral"} />
              <StatTileDl label="Unassigned trainees" value={p.unassigned_trainees} />
            </dl>
            {(p.allocations_without_submission + p.submissions_awaiting_analysis + p.submissions_awaiting_evaluation + p.rework_requested + p.pending_replacements) > 0 && (
              <div className="mt-3"><Alert variant="warning" icon={<Warning />}>Some work is still open. Archiving freezes it as it is now.</Alert></div>
            )}
            <p className="mt-2 text-xs text-muted">
              Scheduled archive: {p.archive_at ? formatIst(p.archive_at) : "not set"} ({p.auto_archive_enabled ? "automatic archiving on" : "automatic archiving off"}).
            </p>
          </div>
        ) : null}
        <FormField label="Reason" htmlFor="archive-reason" required hint="At least 5 characters. Stored with the cycle and in the audit log.">
          <Textarea id="archive-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </FormField>
        <label className="inline-flex items-start gap-2.5 font-medium">
          <input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I understand this cycle becomes read-only and no new allocations will be made in it.
        </label>
        <ApiErrorAlert error={m.error} />
      </div>
    </Dialog>
  );
}

// ---------------------------------------------------------------- history

function CycleHistory({ activeId, viewingId, onView }: { activeId?: string; viewingId: string | null; onView: (id: string) => void }) {
  const cycles = useAllCycles();
  const rows = cycles.data?.data ?? [];
  const cols: Column<Cycle>[] = [
    { key: "name", header: "Cycle", cell: (c) => <span className="font-semibold">{c.name}{c.id === activeId && <span className="ml-1.5 text-xs font-normal text-muted">(active)</span>}</span> },
    { key: "status", header: "Status", cell: (c) => <StatusBadge kind="cycle" value={c.status} /> },
    { key: "deadline", header: "Submission deadline", cell: (c) => <span className="whitespace-nowrap"><IstDateTime value={c.submission_deadline} /></span> },
    { key: "archived", header: "Archived", cell: (c) => <span className="whitespace-nowrap text-muted">{c.archived_at ? formatIst(c.archived_at) : "—"}</span> },
    { key: "view", header: <span className="sr-only">Actions</span>, className: "text-right", cell: (c) => (
      <Button size="sm" variant={viewingId === c.id ? "secondary" : "ghost"} disabled={viewingId === c.id} onClick={() => onView(c.id)}>
        {viewingId === c.id ? "Viewing" : "View overview"}<span className="sr-only"> of {c.name}</span>
      </Button>
    ) },
  ];
  return (
    <Card title="Cycle history" icon={<ClockCounterClockwise />} flush
      actions={<Button size="sm" variant="ghost" icon={<ArrowClockwise />} onClick={() => void cycles.refetch()}>Refresh</Button>}>
      <div className="px-5 pb-5">
        {cycles.isLoading ? <LoadingState /> : cycles.error ? <ErrorState error={cycles.error} onRetry={() => void cycles.refetch()} /> : !rows.length ? (
          <EmptyState icon={<CalendarPlus />} title="No cycles yet" description="Create the first cycle above." />
        ) : (
          <DataTable rows={rows} columns={cols} rowKey={(c) => c.id} caption="Cycle history" />
        )}
      </div>
    </Card>
  );
}
