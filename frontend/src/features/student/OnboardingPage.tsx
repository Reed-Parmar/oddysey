/** Self-service onboarding (ADR-017, ADR-018): save a draft, then finish to be enrolled in the chosen or best-matching
 * open cycle (or wait for one). */
import {
  Archive, CalendarCheck, CheckCircle, FileText, FloppyDisk, Hourglass, IdentificationCard, Info, LockKey, PaperPlaneTilt, WarningCircle,
} from "@phosphor-icons/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { useNavigate } from "react-router-dom";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { CycleOption, Onboarding } from "@/api/types";
import { DateTime, ErrorState, FormField, LoadingState, PageHeader, StatusBadge, useToast } from "@/components/shared";
import { Alert, Button, Card, Input, Textarea, cx } from "@/components/ui";

import { SkillsInput, TradePicker } from "./fields";
import {
  BACKGROUND_MAX, CAREER_MAX, CENTRE_MAX, GENDER_OPTIONS, NAME_MAX, ONBOARDING_FIELDS, ONBOARDING_REQUIRED_TEXT,
  ONBOARDING_SECTIONS, mergeSkills, normaliseSkills, onboardingBody, onboardingMissing, onboardingSchema, onboardingValues,
  type OnboardingValues,
} from "./forms";
import { useOnboarding } from "./hooks";
import { ResumeFill } from "./ResumeFill";

type OnbEnvelope = { data: Onboarding };

/** Refreshes the records StudentGate reads, then leaves; avoids bouncing back on a stale "no trainee" cache. */
function useEnterDashboard() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  return async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: qk.trainees.me(), refetchType: "all" }),
      qc.invalidateQueries({ queryKey: qk.cycles.current(), refetchType: "all" }),
      qc.invalidateQueries({ queryKey: qk.onboarding.me() }),
    ]);
    navigate("/student", { replace: true });
  };
}

function EnrolledRedirect() {
  const enter = useEnterDashboard();
  useEffect(() => {
    void enter();
    // run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <LoadingState label="Opening your dashboard…" />;
}

export function OnboardingPage() {
  const q = useOnboarding();
  if (q.isLoading) return <LoadingState />;
  if (q.error || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  const ob = q.data.data;
  if (ob.enrolled) return <EnrolledRedirect />;
  return (
    <>
      <OnboardingForm onboarding={ob} />
      {ob.has_history && <div className="mt-6"><PastProjects /></div>}
    </>
  );
}

/** Own projects from earlier (archived) cycles stay viewable, read-only (ADR-017 §6.3). */
function PastProjects() {
  const q = useQuery({
    queryKey: qk.allocationHistory.me(),
    queryFn: () => call(api.GET("/api/v1/trainees/me/allocation-history")),
  });
  const rows = q.data?.data ?? [];
  return (
    <Card title="Your previous projects" icon={<Archive />} description="Records from earlier cycles are kept read-only after the cycle is archived.">
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => void q.refetch()} /> : !rows.length ? (
        <p className="text-sm text-muted">No earlier projects.</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {rows.map((h) => (
            <li key={h.allocation.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="min-w-0">
                <span className="font-semibold">{h.allocation.project.title}</span>
                <span className="block text-xs text-muted">{h.allocation.project.project_code} · allocated <DateTime value={h.allocation.created_at} dateOnly /></span>
              </span>
              <span className="flex flex-wrap items-center gap-1.5">
                <StatusBadge kind="allocationStatus" value={h.allocation.status} />
                <span className="rounded bg-neutral-bg px-1.5 text-xs">Archived record</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function SectionProgress({ values }: { values: OnboardingValues }) {
  const missing = new Set(onboardingMissing(values));
  const done = ONBOARDING_SECTIONS.filter((s) => s.fields.every((f) => !missing.has(f))).length;
  return (
    <Card title="Your progress" icon={<CheckCircle />} description={`${done} of ${ONBOARDING_SECTIONS.length} sections complete`}>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-neutral-bg"
        role="progressbar"
        aria-label="Sections complete"
        aria-valuemin={0}
        aria-valuemax={ONBOARDING_SECTIONS.length}
        aria-valuenow={done}
      >
        <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(done / ONBOARDING_SECTIONS.length) * 100}%` }} />
      </div>
      <ul className="mt-4 flex flex-col gap-2 text-sm">
        {ONBOARDING_SECTIONS.map((s) => {
          const ok = s.fields.every((f) => !missing.has(f));
          return (
            <li key={s.key} className="flex items-center gap-2">
              <span
                aria-hidden
                className={cx(
                  "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
                  ok ? "bg-success text-white" : "border border-border-strong bg-surface",
                )}
              >
                {ok && <CheckCircle size={14} weight="bold" />}
              </span>
              <span className={ok ? "text-text" : "text-muted"}>{s.label}</span>
              <span className="sr-only">{ok ? "complete" : "incomplete"}</span>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function OnboardingForm({ onboarding: ob }: { onboarding: Onboarding }) {
  const qc = useQueryClient();
  const toast = useToast();
  const enter = useEnterDashboard();
  const [alert, setAlert] = useState<{ variant: "danger" | "warning"; title?: string; text: string } | null>(null);
  const form = useForm<OnboardingValues>({
    resolver: zodResolver(onboardingSchema),
    defaultValues: onboardingValues(ob.data),
  });
  const { register, handleSubmit, setValue, watch, setError, clearErrors, formState: { errors } } = form;
  const values = watch();

  const applyServerErrors = (e: ApiError): boolean => {
    const fields = e.fieldErrors();
    let mapped = false;
    for (const [f, msg] of Object.entries(fields)) {
      const key = ONBOARDING_FIELDS.find((k) => f === k || f.startsWith(`${k}.`));
      if (!key) continue;
      mapped = true;
      setError(key, { message: msg === "required" ? ONBOARDING_REQUIRED_TEXT[key] ?? "Required" : msg });
    }
    return mapped;
  };

  const saveDraft = (v: OnboardingValues) => call(api.PUT("/api/v1/onboarding", { body: onboardingBody(v) }));

  const handleError = (e: unknown) => {
    if (e instanceof ApiError) {
      if (e.code === "IDENTITY_CONFLICT") {
        setAlert({ variant: "danger", title: "This trainee ID cannot be used", text: e.message });
        setError("trainee_code", { message: "Check this ID" });
        void qc.invalidateQueries({ queryKey: qk.onboarding.me() });
        return;
      }
      if (e.code === "ALREADY_ENROLLED") {
        void enter();
        return;
      }
      if (e.code === "ONBOARDING_INCOMPLETE" || e.status === 422) {
        const mapped = applyServerErrors(e);
        setAlert({ variant: "warning", text: mapped ? "Some required details are missing or invalid. Check the highlighted fields." : errorMessage(e) });
        return;
      }
    }
    setAlert({ variant: "danger", text: errorMessage(e) });
  };

  const save = useMutation({
    mutationFn: saveDraft,
    onSuccess: (res, v) => {
      qc.setQueryData<OnbEnvelope>(qk.onboarding.me(), res);
      form.reset(v);
      toast.success("Progress saved");
    },
    onError: handleError,
  });

  const finish = useMutation({
    mutationFn: async (v: OnboardingValues) => {
      await saveDraft(v);
      return call(api.POST("/api/v1/onboarding/complete"));
    },
    onSuccess: async (res, v) => {
      form.reset(v);
      if (res.data.enrolled) {
        toast.success("You're enrolled. Welcome!");
        await enter();
        return;
      }
      qc.setQueryData<OnbEnvelope>(qk.onboarding.me(), res);
      toast.success("Profile saved");
    },
    onError: handleError,
  });

  const busy = save.isPending || finish.isPending;
  const submitSave = handleSubmit((v) => {
    setAlert(null);
    save.mutate(v);
  });
  const submitFinish = handleSubmit((v) => {
    setAlert(null);
    const missing = onboardingMissing(v);
    if (missing.length) {
      for (const f of missing) setError(f, { message: ONBOARDING_REQUIRED_TEXT[f] ?? "Required" });
      setAlert({ variant: "warning", text: "Complete the required fields first." });
      return;
    }
    finish.mutate(v);
  });
  const setList = (k: "trade_ids" | "skills", v: string[]) => {
    setValue(k, v, { shouldDirty: true });
    clearErrors(k);
  };

  const waiting = ob.status === "waiting_for_cycle";

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Welcome"
        title="Set up your trainee profile"
        description="Tell us about yourself and your ITI training. Projects are allocated to you automatically once you are enrolled."
      />

      {waiting && (
        <section className="rounded-xl border border-primary/30 bg-primary-soft p-5 shadow-card" aria-labelledby="waiting-title">
          <div className="flex items-start gap-3">
            <span aria-hidden className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-fg">
              <Hourglass size={20} />
            </span>
            <div className="min-w-0">
              <h2 id="waiting-title" className="font-heading text-lg font-semibold text-text">You're all set for now</h2>
              <p className="mt-1 text-sm text-text">
                Your profile is saved; you'll be enrolled automatically when the next programme cycle opens. You can still update your details below.
              </p>
            </div>
          </div>
        </section>
      )}
      {ob.status === "identity_conflict" && !alert && (
        <Alert variant="danger" icon={<WarningCircle />} title="This trainee ID cannot be used">{ob.message}</Alert>
      )}
      {!ob.cycle_open && !waiting && (
        <Alert variant="info" icon={<Info />}>
          No programme cycle is open right now. Finish your profile anyway: you'll be enrolled automatically when the next cycle opens.
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <form noValidate className="flex min-w-0 flex-col gap-6" onSubmit={submitFinish}>
          <Card title="About you" icon={<IdentificationCard />}>
            <div className="flex flex-col gap-4">
              <FormField label="Full name" htmlFor="full_name" required error={errors.full_name?.message}>
                <Input id="full_name" autoComplete="name" maxLength={NAME_MAX} {...register("full_name")} />
              </FormField>

              <fieldset className="flex flex-col gap-2" aria-describedby="gender-hint">
                <legend className="mb-1.5 text-sm font-semibold text-text">
                  Gender <span className="text-danger" aria-hidden>*</span>
                </legend>
                <div className="flex flex-wrap gap-2">
                  {GENDER_OPTIONS.map(([value, label]) => (
                    <label
                      key={value}
                      className={cx(
                        "inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 text-sm font-medium transition-colors focus-within:ring-2 focus-within:ring-primary/40",
                        values.gender === value ? "border-primary bg-primary-soft text-primary-ink" : "border-border-strong bg-surface text-text hover:border-primary",
                      )}
                    >
                      <input type="radio" value={value} className="accent-[var(--color-primary)]" {...register("gender", { onChange: () => clearErrors("gender") })} />
                      {label}
                    </label>
                  ))}
                </div>
                <p id="gender-hint" className="flex items-center gap-1 text-xs text-muted">
                  <LockKey aria-hidden size={12} className="shrink-0" />
                  Kept private and never used for matching.
                </p>
                {errors.gender?.message && (
                  <p className="flex items-center gap-1 text-xs font-medium text-danger" role="alert">
                    <WarningCircle aria-hidden size={14} className="shrink-0" />
                    {errors.gender.message}
                  </p>
                )}
              </fieldset>

              <p className="flex items-center gap-1.5 text-xs text-muted">
                <IdentificationCard aria-hidden size={14} className="shrink-0" />
                Your trainee ID is created automatically when you are enrolled.
              </p>
            </div>
          </Card>

          <Card title="Training" icon={<FileText />}>
            <div className="flex flex-col gap-4">
              <TradePicker
                required
                value={values.trade_ids}
                onChange={(v) => setList("trade_ids", v)}
                error={errors.trade_ids?.message}
              />
              <FormField label="Training centre" htmlFor="centre_name" error={errors.centre_name?.message} hint="Optional">
                <Input id="centre_name" maxLength={CENTRE_MAX} {...register("centre_name")} />
              </FormField>
            </div>
          </Card>

          <CycleChoice tradeIds={values.trade_ids} value={values.cycle_id}
            onChange={(v) => setValue("cycle_id", v, { shouldDirty: true })} />

          <Card title="Skills and interests" icon={<CheckCircle />}>
            <div className="flex flex-col gap-4">
              <ResumeFill
                onFill={(s) => {
                  const merged = mergeSkills(values.skills, s.skills) ?? values.skills;
                  const skillsAdded = merged.length - normaliseSkills(values.skills).length;
                  if (skillsAdded) setList("skills", merged);
                  const interestFilled = !!s.career_interest && !values.career_interest.trim();
                  if (interestFilled) {
                    setValue("career_interest", (s.career_interest ?? "").slice(0, CAREER_MAX), { shouldDirty: true });
                    clearErrors("career_interest");
                  }
                  return { skillsAdded, interestFilled };
                }}
              />
              <FormField label="Skills" htmlFor="skills" required>
                <SkillsInput
                  value={values.skills}
                  onChange={(v) => setList("skills", v)}
                  error={errors.skills?.message ?? errors.skills?.[0]?.message}
                />
              </FormField>
              <FormField
                label="Career interest"
                htmlFor="career_interest"
                required
                error={errors.career_interest?.message}
                hint={`${values.career_interest.length} / ${CAREER_MAX}`}
              >
                <Input id="career_interest" maxLength={CAREER_MAX} placeholder="e.g. Solar installation technician" {...register("career_interest")} />
              </FormField>
              <FormField
                label="Background"
                htmlFor="background"
                error={errors.background?.message}
                hint={`Optional · ${values.background.length} / ${BACKGROUND_MAX}`}
              >
                <Textarea id="background" rows={4} maxLength={BACKGROUND_MAX} placeholder="Prior work, hobbies, projects you have done…" {...register("background")} />
              </FormField>
            </div>
          </Card>

          {alert && <Alert variant={alert.variant} icon={<WarningCircle />} title={alert.title}>{alert.text}</Alert>}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" icon={<FloppyDisk />} loading={save.isPending} disabled={busy} onClick={() => void submitSave()}>
              Save progress
            </Button>
            <Button type="submit" icon={<PaperPlaneTilt />} loading={finish.isPending} disabled={busy}>
              Finish
            </Button>
          </div>
        </form>

        <div className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-6">
          <SectionProgress values={values} />
          <Card title="After you finish" icon={<Info />}>
            <ul className="list-disc space-y-2 pl-5 text-sm text-muted">
              <li>You are enrolled in the programme cycle that best matches your trades (or the one you choose), and a suitable project is allocated to you automatically.</li>
              <li>Your trainee ID is generated for you. After enrolment, your resume and profile live on the Profile page.</li>
              <li>Your programme team adds verified assessment marks. You can't edit those.</li>
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}

/**
 * ADR-018: when several cycles are open, show them ranked by how many projects match the selected trades.
 * "Automatic" (the default) lets the server pick the best match at enrolment; hidden when only one cycle is open.
 */
function CycleChoice({ tradeIds, value, onChange }: { tradeIds: string[]; value: string; onChange: (v: string) => void }) {
  const ids = [...new Set(tradeIds)].sort();
  const q = useQuery({
    queryKey: qk.onboarding.cycleOptions(ids),
    queryFn: () => call(api.GET("/api/v1/onboarding/cycle-options", { params: { query: { trade_ids: ids } } })),
    placeholderData: (prev) => prev,
  });
  const options: CycleOption[] = q.data?.data ?? [];
  if (options.length < 2) return null;
  const best = options[0];
  const selected = options.some((o) => o.id === value) ? value : "";
  const choice = (id: string, title: string, detail: string, badge?: string) => (
    <label key={id || "auto"} className={cx(
      "flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors focus-within:ring-2 focus-within:ring-primary/40",
      selected === id ? "border-primary bg-primary-soft" : "border-border-strong bg-surface hover:border-primary",
    )}>
      <input type="radio" name="cycle_id" className="mt-0.5 accent-[var(--color-primary)]" checked={selected === id} onChange={() => onChange(id)} />
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-2 font-semibold text-text">
          {title}
          {badge && <span className="rounded bg-success-bg px-1.5 py-0.5 text-xs font-semibold text-success">{badge}</span>}
        </span>
        <span className="block text-xs text-muted">{detail}</span>
      </span>
    </label>
  );
  const describe = (o: CycleOption) =>
    `${o.matching_projects} of ${o.total_projects} projects match your trades · submission deadline ${new Date(o.submission_deadline).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}`;
  return (
    <Card title="Programme cycle" icon={<CalendarCheck />}
      description="Several cycles are open. We recommend the one with the most projects for your trades; you can pick another.">
      <fieldset className="flex flex-col gap-2" aria-label="Programme cycle">
        {choice("", `Automatic: best match (${best.name})`, ids.length ? "Updated as you change your trades." : "Choose your trades first for a better match.")}
        {options.map((o) => choice(o.id, o.name, describe(o), o.recommended ? "Recommended" : undefined))}
      </fieldset>
    </Card>
  );
}
