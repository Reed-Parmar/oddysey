/** /admin/trainees and /admin/trainees/:traineeId (TRN-03/04/06, IMP-01, INV-02, REC-03, ALLOC-01; admin.md §3.2–3.3). */
import { zodResolver } from "@hookform/resolvers/zod";
import { GraduationCap, LinkSimple, PencilSimple, Sparkle, Target, UploadSimple, UserPlus } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { Controller, useForm } from "react-hook-form";
import { Link, useNavigate, useParams } from "react-router-dom";
import { z } from "zod";

import { api, call } from "@/api/client";
import { ApiError } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Trainee, TraineeAdminPatch } from "@/api/types";
import {
  Avatar, BackLink, DataTable, EmptyState, ErrorState, FormField, KeyValue, LoadingState, PageHeader, Pagination,
  ScoreBar, SkillChips, StatusBadge, useToast, type Column,
} from "@/components/shared";
import { Button, Card, Dialog, Input, Select, Textarea } from "@/components/ui";
import { FactorTable, RecommendationCard, TraineeProfileView, TraineeResumeCard } from "@/features/shared/views";
import { formatScore } from "@/lib/format";

import {
  ActionStack, ApiErrorAlert, CardState, CycleSelect, FilterBar, FormSection, InviteUrlReveal, LabeledSelect, LinkButton,
  MetaLine, ReadOnlyBanner, SearchInput, SkillsInput, TableCard, TextLink, WarningsAlert, applyFieldErrors, triState,
  useDebounced, useInvalidate, useScopedCycle, useTrades,
} from "./common";
import { ImportDialog } from "./ImportPanel";

// ---------------------------------------------------------------- list

export function TraineesPage() {
  const navigate = useNavigate();
  const invalidate = useInvalidate();
  const [cycleSel, setCycleSel] = useState("");
  const [q, setQ] = useState("");
  const [trade, setTrade] = useState("");
  const [assessment, setAssessment] = useState("");
  const [allocated, setAllocated] = useState("");
  const [linked, setLinked] = useState("");
  const [openInv, setOpenInv] = useState("");
  const [sort, setSort] = useState("full_name");
  const [page, setPage] = useState(1);
  const [importOpen, setImportOpen] = useState(false);
  const dq = useDebounced(q.trim());
  const scope = useScopedCycle(cycleSel);
  const trades = useTrades();

  const query = {
    cycle_id: scope.id, q: dq || undefined, trade_id: trade || undefined,
    assessment_status: (assessment || undefined) as Trainee["assessment_status"] | undefined,
    allocated: triState(allocated), linked: triState(linked), has_open_invitation: triState(openInv), sort, page, page_size: 20,
  };
  const list = useQuery({
    queryKey: qk.trainees.list(query),
    queryFn: () => call(api.GET("/api/v1/trainees", { params: { query } })),
    enabled: !!scope.id,
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  const importReason = !scope.id ? "Create a cycle first" : scope.cycle?.status === "archived" ? "Cycle is archived (read-only)" : undefined;
  const filtered = !!(dq || trade || assessment || allocated || linked || openInv);

  const cols: Column<Trainee>[] = [
    { key: "code", header: "Code", sort: "trainee_code", cell: (t) => <span className="font-medium whitespace-nowrap text-muted tabular-nums">{t.trainee_code}</span> },
    { key: "name", header: "Name", sort: "full_name", cell: (t) => (
      <span className="flex min-w-40 items-center gap-2.5">
        <Avatar name={t.full_name} size="sm" />
        <Link className="font-semibold text-text hover:text-primary hover:underline" to={`/admin/trainees/${t.id}`} onClick={(e) => e.stopPropagation()}>{t.full_name}</Link>
      </span>
    ) },
    { key: "trade", header: "Trade", cell: (t) => <span className="whitespace-nowrap">{t.trade.name}</span> },
    { key: "centre", header: "Centre", cell: (t) => t.centre_name ?? <span className="text-muted">—</span> },
    { key: "scores", header: "Theory / Practical / Safety", sort: "-practical_score", cell: (t) => (
      <span className="tabular-nums whitespace-nowrap">{formatScore(t.scores.theory)} / {formatScore(t.scores.practical)} / {formatScore(t.scores.safety)}</span>
    ) },
    { key: "assessment", header: "Assessment", cell: (t) => <StatusBadge kind="assessment" value={t.assessment_status} /> },
    { key: "account", header: "Account", cell: (t) => t.account ? (
      <span className="inline-flex items-center gap-1.5 break-all"><LinkSimple aria-hidden size={14} className="shrink-0 text-success" />{t.account.email}</span>
    ) : <span className="text-muted">No account</span> },
    { key: "skills", header: "Skills", className: "min-w-56", cell: (t) => <SkillChips skills={t.skills} /> },
  ];

  return (
    <div>
      <PageHeader title="Trainees" description="Trainee records owned by the programme team. Import the Trainee Profiles sheet or edit records one by one."
        actions={<ActionStack reason={importReason}>
          <Button icon={<UploadSimple />} disabled={!!importReason} onClick={() => setImportOpen(true)}>Import trainees</Button>
        </ActionStack>} />
      {scope.isLoading ? <LoadingState /> : scope.error ? <ErrorState error={scope.error} /> : !scope.id ? (
        <EmptyState icon={<GraduationCap />} title="No active cycle" description="Create a cycle before importing trainees."
          action={<LinkButton to="/admin/cycles?create=1">Create a cycle</LinkButton>} />
      ) : (
        <TableCard
          title="Trainee records" icon={<GraduationCap />}
          description={list.data ? `${list.data.meta.total} ${list.data.meta.total === 1 ? "trainee" : "trainees"}${filtered ? " match these filters" : ""}${scope.cycle ? ` in ${scope.cycle.name}` : ""}` : undefined}
          toolbar={<FilterBar>
            <CycleSelect value={scope.id} onChange={reset(setCycleSel)} cycles={scope.cycles} activeId={scope.active?.id} />
            <SearchInput id="trainee-q" label="Search" value={q} onChange={reset(setQ)} placeholder="Name, code or centre" />
            <LabeledSelect id="trainee-trade" label="Trade" value={trade} onChange={reset(setTrade)}>
              <option value="">All trades</option>
              {(trades.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </LabeledSelect>
            <LabeledSelect id="trainee-assessment" label="Assessment" value={assessment} onChange={reset(setAssessment)}>
              <option value="">Any</option>
              <option value="complete">Assessed</option>
              <option value="pending">Assessment pending</option>
            </LabeledSelect>
            <LabeledSelect id="trainee-allocated" label="Allocated" value={allocated} onChange={reset(setAllocated)}>
              <option value="">Any</option><option value="true">Allocated</option><option value="false">Not allocated</option>
            </LabeledSelect>
            <LabeledSelect id="trainee-linked" label="Account" value={linked} onChange={reset(setLinked)}>
              <option value="">Any</option><option value="true">Linked</option><option value="false">No account</option>
            </LabeledSelect>
            <LabeledSelect id="trainee-inv" label="Open invitation" value={openInv} onChange={reset(setOpenInv)}>
              <option value="">Any</option><option value="true">Yes</option><option value="false">No</option>
            </LabeledSelect>
            <LabeledSelect id="trainee-sort" label="Sort" value={sort} onChange={reset(setSort)}>
              <option value="full_name">Name</option>
              <option value="trainee_code">Code</option>
              <option value="-practical_score">Practical score (high first)</option>
            </LabeledSelect>
          </FilterBar>}
          footer={list.data?.data.length ? <Pagination meta={list.data.meta} onPageChange={setPage} /> : undefined}>
          {list.isLoading ? <CardState><LoadingState /></CardState> : list.error ? <CardState><ErrorState error={list.error} onRetry={() => list.refetch()} /></CardState> :
            !list.data?.data.length ? (
              <CardState>
                {filtered ? <EmptyState icon={<GraduationCap />} title="No trainees match these filters" /> : (
                  <EmptyState icon={<GraduationCap />} title="No trainees yet" description="Import the Trainee Profiles sheet to add trainees to this cycle."
                    action={!importReason ? <Button icon={<UploadSimple />} onClick={() => setImportOpen(true)}>Import trainees</Button> : undefined} />
                )}
              </CardState>
            ) : (
              <DataTable rows={list.data.data} columns={cols} rowKey={(t) => t.id} sort={sort} onSortChange={reset(setSort)}
                onRowClick={(t) => navigate(`/admin/trainees/${t.id}`)} caption="Trainees" />
            )}
        </TableCard>
      )}
      {scope.id && (
        <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} endpoint="/admin/imports/trainees" cycleId={scope.id}
          noun="trainees" onApplied={() => invalidate(qk.trainees.all(), qk.trades.all(), qk.skills.all(), qk.progress.all(), qk.reports.all())} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- detail

export function TraineeDetailPage() {
  const { traineeId = "" } = useParams();
  const t = useQuery({
    queryKey: qk.trainees.detail(traineeId),
    queryFn: () => call(api.GET("/api/v1/trainees/{trainee_id}", { params: { path: { trainee_id: traineeId } } })),
  });
  const cycleId = t.data?.data.cycle_id ?? "";
  const cycle = useQuery({
    queryKey: qk.cycles.detail(cycleId),
    queryFn: () => call(api.GET("/api/v1/cycles/{cycle_id}", { params: { path: { cycle_id: cycleId } } })),
    enabled: !!cycleId,
  });
  const [warnings, setWarnings] = useState<string[]>([]);
  const [inviteOpen, setInviteOpen] = useState(false);

  if (t.isLoading) return <LoadingState />;
  if (t.error || !t.data) return <ErrorState error={t.error} onRetry={() => t.refetch()} />;
  const trainee = t.data.data;
  const archived = cycle.data?.data.status === "archived";
  const inviteReason = archived ? "Cycle is archived (read-only)"
    : trainee.account ? `Account already linked (${trainee.account.email})` : undefined;

  return (
    <div className="space-y-6">
      <PageHeader title={trainee.full_name} eyebrow={<BackLink to="/admin/trainees">All trainees</BackLink>}
        description={<MetaLine items={[
          <span key="c" className="font-medium tabular-nums">{trainee.trainee_code}</span>,
          trainee.trade.name,
          cycle.data ? cycle.data.data.name : null,
        ]} />}
        actions={<ActionStack reason={inviteReason}>
          <Button variant="secondary" icon={<UserPlus />} disabled={!!inviteReason} onClick={() => setInviteOpen(true)}>Invite student</Button>
        </ActionStack>} />
      {archived && <ReadOnlyBanner />}
      <WarningsAlert warnings={warnings} onDismiss={() => setWarnings([])} />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <TraineeProfileView trainee={trainee} showSensitive />
        <AllocationPanel trainee={trainee} />
      </div>
      <TraineeResumeCard traineeId={trainee.id} canDownload />
      <TraineeRecommendations trainee={trainee} />
      <TraineeEditForm key={trainee.updated_at} trainee={trainee} readOnly={archived} onWarnings={setWarnings} />
      <InviteStudentDialog open={inviteOpen} onClose={() => setInviteOpen(false)} trainee={trainee} />
    </div>
  );
}

function AllocationPanel({ trainee }: { trainee: Trainee }) {
  const params = { cycle_id: trainee.cycle_id, trainee_id: trainee.id };
  const alloc = useQuery({
    queryKey: qk.allocations.list(params),
    queryFn: () => call(api.GET("/api/v1/allocations", { params: { query: params } })),
  });
  const pParams = { ...params, include_unallocated: true };
  const prog = useQuery({
    queryKey: qk.progress.list(pParams),
    queryFn: () => call(api.GET("/api/v1/progress", { params: { query: pParams } })),
  });
  const a = alloc.data?.data[0];
  const row = prog.data?.data[0];
  return (
    <Card title="Allocation" icon={<Target />} actions={<TextLink to="/admin/allocations">Manage allocations</TextLink>}>
      {alloc.isLoading || prog.isLoading ? <LoadingState /> : alloc.error ? <ErrorState error={alloc.error} onRetry={() => alloc.refetch()} /> : !a ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border-strong bg-surface-2 p-4 text-sm">
          <StatusBadge kind="progress" value="unallocated" />
          <span className="text-muted">Not allocated yet. Allocate on the Allocations page.</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <KeyValue items={[
            ["Status", <span key="s" className="flex flex-wrap gap-1">
              <StatusBadge kind="progress" value={row?.progress ?? "allocated"} />
              {row?.latest_submission?.is_late && <StatusBadge kind="late" value="late" />}
            </span>],
            ["Project", <TextLink key="p" to={`/admin/projects/${a.project.id}`}>{a.project.title} · {a.project.project_code}</TextLink>],
            ["Supervisor", a.project.supervisor ? `${a.project.supervisor.full_name}${a.project.supervisor.department ? ` (${a.project.supervisor.department})` : ""}` : "Not assigned"],
            ["Source", <span key="src" className="flex flex-wrap gap-1">
              <StatusBadge kind="allocationSource" value={a.source} />
              {a.is_override && <StatusBadge kind="allocationSource" value="override" />}
            </span>],
            ...(a.is_override ? [["Override reason", a.override_reason ?? "—"] as [string, string]] : []),
            ["Match score", <ScoreBar key="m" value={a.match_score} label="Match score" />],
            ...(row?.latest_submission ? [["Latest submission", <TextLink key="sub" to={`/admin/submissions/${row.latest_submission.id}`}>Version {row.latest_submission.version}</TextLink>] as [string, ReactNode]] : []),
          ]} />
          {a.factors ? (
            <details className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
              <summary className="cursor-pointer font-semibold text-primary">Why this match?</summary>
              <FactorTable factors={a.factors} />
            </details>
          ) : <p className="text-xs text-muted">Manual allocation without a recommendation: match score only.</p>}
        </div>
      )}
    </Card>
  );
}

function TraineeRecommendations({ trainee }: { trainee: Trainee }) {
  const params = { cycle_id: trainee.cycle_id, trainee_id: trainee.id, sort: "rank", page_size: 50 };
  const q = useQuery({
    queryKey: qk.recommendations.list(params),
    queryFn: () => call(api.GET("/api/v1/recommendations", { params: { query: params } })),
  });
  return (
    <Card title="Recommendations" icon={<Sparkle />} description="Latest completed run, best match first"
      actions={<TextLink to="/admin/recommendations">All recommendations</TextLink>}>
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data?.data.length ? (
        <EmptyState icon={<Sparkle />} title="No recommendations for this trainee yet"
          description={trainee.assessment_status === "pending" ? "Assessment pending: recommendations need all three scores." : <TextLink to="/admin/recommendations">Run recommendations</TextLink>} />
      ) : (
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          {q.data.data.map((r) => <RecommendationCard key={r.id} recommendation={r} perspective="trainee" />)}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- edit (TRN-06)

const score = z.string().trim().refine((v) => v === "" || (!Number.isNaN(Number(v)) && Number(v) >= 0 && Number(v) <= 100), "0–100, or blank");
const traineeSchema = z.object({
  trainee_code: z.string().trim().min(1, "Required").max(40, "At most 40 characters"),
  full_name: z.string().trim().min(1, "Required").max(120, "At most 120 characters"),
  gender: z.string(),
  trade_id: z.string().min(1, "Required"),
  centre_name: z.string().trim().max(200, "At most 200 characters"),
  theory: score, practical: score, safety: score,
  skills: z.array(z.string()).max(15, "At most 15 skills"),
  career_interest: z.string().trim().max(200, "At most 200 characters"),
  background: z.string().trim().max(2000, "At most 2000 characters"),
});
type TraineeForm = z.infer<typeof traineeSchema>;
const FIELDS = ["trainee_code", "full_name", "gender", "trade_id", "centre_name", "theory", "practical", "safety", "skills", "career_interest", "background"] as const;

function toForm(t: Trainee): TraineeForm {
  const s = (n: number | null) => (n == null ? "" : String(n));
  return {
    trainee_code: t.trainee_code, full_name: t.full_name, gender: t.gender ?? "", trade_id: t.trade.id,
    centre_name: t.centre_name ?? "", theory: s(t.scores.theory), practical: s(t.scores.practical), safety: s(t.scores.safety),
    skills: t.skills.map((k) => k.name), career_interest: t.career_interest ?? "", background: t.background ?? "",
  };
}

/** Only the changed fields (TRN-06 patch semantics). */
export function traineePatch(before: TraineeForm, v: TraineeForm): TraineeAdminPatch {
  const body: TraineeAdminPatch = {};
  const str = (x: string) => (x.trim() === "" ? null : x.trim());
  if (v.trainee_code.trim() !== before.trainee_code) body.trainee_code = v.trainee_code.trim();
  if (v.full_name.trim() !== before.full_name) body.full_name = v.full_name.trim();
  if (v.gender !== before.gender) body.gender = (v.gender || null) as TraineeAdminPatch["gender"];
  if (v.trade_id !== before.trade_id) body.trade_id = v.trade_id;
  if (v.centre_name.trim() !== before.centre_name) body.centre_name = str(v.centre_name);
  if (v.career_interest.trim() !== before.career_interest) body.career_interest = str(v.career_interest);
  if (v.background.trim() !== before.background) body.background = str(v.background);
  const scores: NonNullable<TraineeAdminPatch["scores"]> = {};
  for (const k of ["theory", "practical", "safety"] as const) {
    if (v[k].trim() !== before[k]) scores[k] = v[k].trim() === "" ? null : Number(v[k]);
  }
  if (Object.keys(scores).length) body.scores = scores;
  const norm = (a: string[]) => a.map((x) => x.toLowerCase()).sort().join("\n");
  if (norm(v.skills) !== norm(before.skills)) body.skills = v.skills;
  return body;
}

function TraineeEditForm({ trainee, readOnly, onWarnings }: { trainee: Trainee; readOnly: boolean; onWarnings: (w: string[]) => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const trades = useTrades();
  const initial = toForm(trainee);
  const form = useForm<TraineeForm>({ resolver: zodResolver(traineeSchema), defaultValues: initial });
  const err = form.formState.errors;
  const [alertError, setAlertError] = useState<unknown>(null);
  const m = useMutation({
    mutationFn: (body: TraineeAdminPatch) => call(api.PATCH("/api/v1/trainees/{trainee_id}", { params: { path: { trainee_id: trainee.id } }, body })),
    onMutate: () => setAlertError(null),
    onSuccess: (res) => {
      onWarnings(res.meta?.warnings ?? []);
      invalidate(qk.trainees.all(), qk.skills.all(), qk.progress.all(), qk.allocations.all(), qk.recommendations.all(), qk.reports.all());
      toast.success("Trainee saved");
    },
    onError: (e) => {
      let mapped = false;
      const fe = e instanceof ApiError ? e.fieldErrors() : {};
      for (const k of ["theory", "practical", "safety"] as const) {
        if (fe[`scores.${k}`]) { form.setError(k, { message: fe[`scores.${k}`] }); mapped = true; }
      }
      if (!applyFieldErrors(e, form.setError, FIELDS, { DUPLICATE_CODE: "trainee_code" }) && !mapped) setAlertError(e);
    },
  });
  return (
    <Card title="Edit trainee record" icon={<PencilSimple />} description="Only changed fields are saved.">
      {readOnly && <p className="mb-3 text-xs text-muted">Cycle is archived (read-only).</p>}
      <form noValidate className="flex flex-col gap-5" onSubmit={form.handleSubmit((v) => {
        const body = traineePatch(initial, v);
        if (!Object.keys(body).length) { toast.info("No changes to save"); return; }
        m.mutate(body);
      })}>
        <ApiErrorAlert error={alertError} />
        <fieldset disabled={readOnly} className="flex min-w-0 flex-col gap-6">
          <FormSection title="Identity">
          <FormField label="Trainee code" htmlFor="tr-code" required error={err.trainee_code?.message}>
            <Input id="tr-code" maxLength={40} {...form.register("trainee_code")} />
          </FormField>
          <FormField label="Full name" htmlFor="tr-name" required error={err.full_name?.message}>
            <Input id="tr-name" maxLength={120} {...form.register("full_name")} />
          </FormField>
          <FormField label="Gender" htmlFor="tr-gender" hint="Admin only. Never used for scoring." error={err.gender?.message}>
            <Select id="tr-gender" {...form.register("gender")}>
              <option value="">Not recorded</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other</option>
              <option value="undisclosed">Undisclosed</option>
            </Select>
          </FormField>
          <FormField label="Trade" htmlFor="tr-trade" required error={err.trade_id?.message}>
            <Select id="tr-trade" {...form.register("trade_id")}>
              {!trades.data && <option value={trainee.trade.id}>{trainee.trade.name}</option>}
              {(trades.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </FormField>
          <FormField label="Training centre" htmlFor="tr-centre" error={err.centre_name?.message}>
            <Input id="tr-centre" maxLength={200} {...form.register("centre_name")} />
          </FormField>
          </FormSection>
          <FormSection title="Assessment scores" description="Percentages from the ITI assessment. Leave blank while the assessment is pending.">
          <div className="grid grid-cols-3 gap-3 md:col-span-2 md:max-w-xl">
            <FormField label="Theory %" htmlFor="tr-theory" error={err.theory?.message}>
              <Input id="tr-theory" inputMode="decimal" {...form.register("theory")} />
            </FormField>
            <FormField label="Practical %" htmlFor="tr-practical" error={err.practical?.message}>
              <Input id="tr-practical" inputMode="decimal" {...form.register("practical")} />
            </FormField>
            <FormField label="Safety %" htmlFor="tr-safety" error={err.safety?.message}>
              <Input id="tr-safety" inputMode="decimal" {...form.register("safety")} />
            </FormField>
          </div>
          </FormSection>
          <FormSection title="Skills and interests">
          <div className="md:col-span-2">
            <FormField label="Skills" htmlFor="tr-skills" hint="Up to 15. New names are created automatically." error={err.skills?.message}>
              <Controller control={form.control} name="skills" render={({ field }) => (
                <SkillsInput id="tr-skills" value={field.value} onChange={field.onChange} disabled={readOnly} />
              )} />
            </FormField>
          </div>
          <FormField label="Career interest" htmlFor="tr-interest" error={err.career_interest?.message}>
            <Input id="tr-interest" maxLength={200} {...form.register("career_interest")} />
          </FormField>
          <div className="md:col-span-2">
            <FormField label="Background" htmlFor="tr-bg" error={err.background?.message}>
              <Textarea id="tr-bg" maxLength={2000} {...form.register("background")} />
            </FormField>
          </div>
          </FormSection>
        </fieldset>
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">
          <Button type="submit" loading={m.isPending} disabled={readOnly || !form.formState.isDirty}>Save changes</Button>
          <Button variant="secondary" disabled={readOnly || !form.formState.isDirty || m.isPending} onClick={() => form.reset(initial)}>Discard changes</Button>
        </div>
      </form>
    </Card>
  );
}

// ---------------------------------------------------------------- invite (INV-02, role=student)

const emailSchema = z.object({ email: z.string().trim().email("Enter a valid email").max(254) });

function InviteStudentDialog({ open, onClose, trainee }: { open: boolean; onClose: () => void; trainee: Trainee }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [url, setUrl] = useState<string | null>(null);
  const form = useForm<{ email: string }>({ resolver: zodResolver(emailSchema), defaultValues: { email: "" } });
  const [alertError, setAlertError] = useState<unknown>(null);
  const m = useMutation({
    mutationFn: (email: string) => call(api.POST("/api/v1/admin/invitations", { body: { email, role: "student", trainee_id: trainee.id } })),
    onMutate: () => setAlertError(null),
    onSuccess: (res) => {
      setUrl(res.data.invite_url);
      invalidate(qk.invitations.all(), qk.trainees.all(), qk.reports.all());
      toast.success("Invitation created");
    },
    onError: (e) => { if (!applyFieldErrors(e, form.setError, ["email"], { EMAIL_IN_USE: "email" })) setAlertError(e); },
  });
  const close = () => { setUrl(null); setAlertError(null); form.reset(); m.reset(); onClose(); };
  return (
    <Dialog open={open} onClose={close} title={`Invite ${trainee.full_name}`} description="Creates a one-time sign-up link bound to this trainee record." footer={url ? <Button onClick={close}>Done</Button> : <>
      <Button variant="secondary" onClick={close}>Cancel</Button>
      <Button type="submit" form="invite-student" loading={m.isPending}>Create invitation</Button>
    </>}>
      {url ? <InviteUrlReveal url={url} onCopied={() => toast.success("Copied")} /> : (
        <form id="invite-student" noValidate className="flex flex-col gap-3" onSubmit={form.handleSubmit((v) => m.mutate(v.email.trim()))}>
          <p className="text-sm text-muted">The student account will be linked to {trainee.trainee_code} when they register with this link.</p>
          <ApiErrorAlert error={alertError} />
          <FormField label="Student email" htmlFor="invite-email" required error={form.formState.errors.email?.message}>
            <Input id="invite-email" type="email" autoComplete="off" {...form.register("email")} />
          </FormField>
        </form>
      )}
    </Dialog>
  );
}
