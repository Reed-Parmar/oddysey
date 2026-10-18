/** Profile page sections (ADR-024): programme-managed facts, resume, the self-editable profile and resume-reported marks. */
import { FloppyDisk, IdentificationCard, LockKey, NotePencil, Quotes, SealCheck, WarningCircle } from "@phosphor-icons/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Resume, TraineeMe } from "@/api/types";
import { Avatar, DateTime, FormError, FormField, ScoreBar, SkillChips, Skeleton, StatusBadge, useToast } from "@/components/shared";
import { Alert, Button, Card, Input, Textarea } from "@/components/ui";
import { formatScore } from "@/lib/format";

import { TradePicker } from "./fields";
import {
  BACKGROUND_MAX, MARK_FIELDS, initialMarks, markError, profileBody, profileSchema, reportedScoresBody,
  reportedValue, type MarkField, type MarkValues, type ProfileValues,
} from "./forms";
import { useMyResume } from "./hooks";
import { ResumePanel } from "./ResumePanel";
import { Fact } from "./ui";

const MODE_TEXT: Record<string, string> = {
  full: "Your programme team has entered all verified marks, so matching uses practical, skills, interest, theory and safety.",
  profile: "Verified marks are not complete yet, so matching uses your skills and career interest only (profile fit, not competence).",
};

/** Fields owned by the programme team (read-only for the trainee). Gender is never shown here. */
function ManagedRecord({ me }: { me: TraineeMe }) {
  const scores = [["Theory", me.scores.theory], ["Practical", me.scores.practical], ["Safety compliance", me.scores.safety]] as const;
  return (
    <Card
      title="Programme record"
      description="Managed by your programme team. Ask your coordinator if something is wrong."
      icon={<LockKey />}
    >
      <div className="flex items-center gap-3 rounded-lg bg-surface-2 p-3">
        <Avatar name={me.full_name} />
        <div className="min-w-0">
          <p className="font-semibold text-text [overflow-wrap:anywhere]">{me.full_name}</p>
          <p className="flex items-center gap-1 text-xs text-muted">
            <IdentificationCard aria-hidden size={14} />
            <span className="sr-only">Trainee code: </span>
            {me.trainee_code}
          </p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4">
        <Fact label="Trainee code">{me.trainee_code}</Fact>
        <Fact label="Training centre">{me.centre_name ?? "—"}</Fact>
        <div className="col-span-2">
          <Fact label="Matching mode">
            <span className="flex flex-col items-start gap-1.5">
              <StatusBadge kind="matchMode" value={me.match_mode} />
              <span className="text-xs font-normal text-muted">{MODE_TEXT[me.match_mode] ?? ""}</span>
            </span>
          </Fact>
        </div>
      </dl>
      <h3 className="mt-5 mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
        <SealCheck aria-hidden size={14} className="text-success" />
        Assessment marks · Verified (programme)
      </h3>
      <p className="mb-3 text-xs text-muted">Entered by your programme team. These are authoritative and can't be edited here.</p>
      <dl className="flex flex-col gap-3">
        {scores.map(([k, v]) => (
          <div key={k} className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-sm text-muted">{k}</dt>
            <dd>{v == null ? <span className="text-sm text-muted">Not entered yet</span> : <ScoreBar value={v} label={k} tone="auto" />}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

const FIELD_KEYS = ["trade_ids", "skills", "career_interest", "background"] as const;

function ProfileForm({ me }: { me: TraineeMe }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [formError, setFormError] = useState<unknown>(null);
  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      trade_ids: me.trades.map((t) => t.id),
      skills: me.skills.map((s) => s.name),
      career_interest: me.career_interest ?? "",
      background: me.background ?? "",
    },
  });
  const { register, handleSubmit, setValue, watch, setError, formState } = form;
  const [tradeIds, background] = watch(["trade_ids", "background"]);
  const hasResume = !!useMyResume().data?.data;

  const save = useMutation({
    mutationFn: (v: ProfileValues) => call(api.PATCH("/api/v1/trainees/me", { body: profileBody(v) })),
    onSuccess: async () => {
      toast.success("Profile saved");
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.trainees.me() }),
        qc.invalidateQueries({ queryKey: qk.resumes.me() }),
        qc.invalidateQueries({ queryKey: qk.skills.all() }),
      ]);
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        if (e.code === "NO_ACTIVE_CYCLE") void qc.invalidateQueries({ queryKey: qk.cycles.current() });
        if (e.code === "NO_TRAINEE_RECORD") void qc.invalidateQueries({ queryKey: qk.trainees.me() });
        const fields = e.fieldErrors();
        const unmapped: string[] = [];
        for (const [f, msg] of Object.entries(fields)) {
          const key = FIELD_KEYS.find((k) => f === k || f.startsWith(`${k}.`));
          if (key) setError(key, { message: msg });
          else unmapped.push(msg);
        }
        if (Object.keys(fields).length && !unmapped.length) {
          setFormError(null);
          return;
        }
      }
      setFormError(e);
    },
  });

  return (
    <Card title="About you" description="Used the next time projects are matched." icon={<NotePencil />}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={handleSubmit((v) => {
          setFormError(null);
          save.mutate(v);
        })}
      >
        <TradePicker
          required
          value={tradeIds}
          onChange={(v) => setValue("trade_ids", v, { shouldDirty: true, shouldValidate: true })}
          error={formState.errors.trade_ids?.message}
        />
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface-2 p-4">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-text">
              Skills <LockKey aria-hidden size={14} className="text-subtle" /><span className="sr-only">(read-only)</span>
            </p>
            <div className="mt-2"><SkillChips skills={me.skills} /></div>
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-text">
              Career interest <LockKey aria-hidden size={14} className="text-subtle" /><span className="sr-only">(read-only)</span>
            </p>
            <p className="mt-1 text-sm text-text [overflow-wrap:anywhere]">{me.career_interest || <span className="text-muted">Not set</span>}</p>
          </div>
          <p className="text-xs text-muted">
            {hasResume
              ? "These come from your resume. To change them, upload a new resume in Update resume above and save its suggestions."
              : "These come from your resume. Upload your resume in Update resume above to add or change them."}
          </p>
        </div>
        <FormField
          label="Background"
          htmlFor="background"
          error={formState.errors.background?.message}
          hint={`${background.length} / ${BACKGROUND_MAX}`}
        >
          <Textarea id="background" rows={4} maxLength={BACKGROUND_MAX} placeholder="Prior work, hobbies, projects you have done…" {...register("background")} />
        </FormField>
        <FormError error={formError} />
        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted">Changes don't move a project you already have.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" icon={<FloppyDisk />} loading={save.isPending} disabled={!formState.isDirty}>
              Save changes
            </Button>
            <Button variant="secondary" disabled={!formState.isDirty || save.isPending} onClick={() => form.reset()}>
              Discard changes
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}

const MARK_STATUS: Record<string, string> = {
  found: "Found in your resume",
  not_found: "Not found in your resume",
  ambiguous: "Unclear in your resume: please check",
};

const UNVERIFIED_NOTE =
  "Resume-reported, unverified — not used for allocation gates; your programme team's verified marks are authoritative.";

function SavedReportedMarks({ me }: { me: TraineeMe }) {
  const saved = me.reported_scores;
  if (!saved) return null;
  const confirmedAt = typeof saved.confirmed_at === "string" ? saved.confirmed_at : null;
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <p className="text-xs font-semibold tracking-wide text-muted uppercase">Saved resume-reported marks</p>
      <dl className="mt-2 grid grid-cols-3 gap-3">
        {MARK_FIELDS.map(([f, label]) => {
          const v = reportedValue(saved, f);
          return <Fact key={f} label={label}><span className="tabular-nums">{v == null ? "—" : formatScore(v)}</span></Fact>;
        })}
      </dl>
      <p className="mt-2 text-xs text-muted">
        {UNVERIFIED_NOTE}
        {confirmedAt && <> Saved <DateTime value={confirmedAt} />.</>}
      </p>
    </div>
  );
}

function ReportedMarksForm({ me, resume }: { me: TraineeMe; resume: Resume }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [values, setValues] = useState<MarkValues>(() => initialMarks(resume, me.reported_scores));
  const [problem, setProblem] = useState<unknown>(null);
  const marks = new Map((resume.extracted?.assessment_marks ?? []).map((m) => [m.field, m]));
  const errors = Object.fromEntries(MARK_FIELDS.map(([f]) => [f, markError(values[f])])) as Record<MarkField, string | null>;
  const hasError = Object.values(errors).some(Boolean);
  const empty = MARK_FIELDS.every(([f]) => !values[f].trim());

  const save = useMutation({
    mutationFn: () => call(api.PATCH("/api/v1/trainees/me", { body: reportedScoresBody(resume.id, values) })),
    onSuccess: async () => {
      setProblem(null);
      toast.success("Resume-reported marks saved (unverified)");
      await qc.invalidateQueries({ queryKey: qk.trainees.me() });
    },
    onError: setProblem,
  });

  return (
    <form
      noValidate
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!hasError && !empty) save.mutate();
      }}
    >
      <ul className="flex flex-col gap-4">
        {MARK_FIELDS.map(([f, label]) => {
          const m = marks.get(f);
          const id = `reported-${f}`;
          return (
            <li key={f} className="rounded-lg border border-border p-3">
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                  <label htmlFor={id} className="text-sm font-semibold text-text">{label}</label>
                  <p className="text-xs text-muted">{m ? MARK_STATUS[m.status] ?? m.status : MARK_STATUS.not_found}</p>
                </div>
                <div className="w-28">
                  <Input
                    id={id}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={100}
                    step="0.1"
                    value={values[f]}
                    aria-invalid={!!errors[f] || undefined}
                    aria-describedby={errors[f] ? `${id}-error` : undefined}
                    onChange={(e) => setValues((v) => ({ ...v, [f]: e.target.value }))}
                  />
                </div>
              </div>
              {m?.excerpt && (
                <blockquote className="mt-2 flex gap-2 border-l-2 border-border-strong pl-3 text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
                  <Quotes aria-hidden size={12} className="mt-0.5 shrink-0" />
                  <span><span className="sr-only">Excerpt from your resume: </span>{m.excerpt}</span>
                </blockquote>
              )}
              {errors[f] && (
                <p id={`${id}-error`} className="mt-1 flex items-center gap-1 text-xs font-medium text-danger" role="alert">
                  <WarningCircle aria-hidden size={14} className="shrink-0" />
                  {errors[f]}
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <FormError error={problem} />
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted">Marks out of 100. Leave a field empty if your resume doesn't list it.</p>
        <Button type="submit" size="sm" icon={<FloppyDisk />} loading={save.isPending} disabled={hasError || empty}>
          Confirm marks
        </Button>
      </div>
    </form>
  );
}

/** Marks read from the latest resume: the trainee confirms or corrects them; they stay unverified (ADR-017). */
function ReportedMarksCard({ me }: { me: TraineeMe }) {
  const resumeQ = useMyResume();
  const r = resumeQ.data?.data ?? null;
  const hasMarks = !!r && r.status === "extracted" && (r.extracted?.assessment_marks.length ?? 0) > 0;
  return (
    <Card title="Resume-reported marks" icon={<Quotes />} description="ITI marks your resume lists, confirmed by you.">
      <div className="flex flex-col gap-4">
        <Alert variant="info" icon={<WarningCircle />}>{UNVERIFIED_NOTE}</Alert>
        <SavedReportedMarks me={me} />
        {resumeQ.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : resumeQ.error ? (
          <p className="text-sm text-danger" role="alert">{errorMessage(resumeQ.error)}</p>
        ) : !r ? (
          <p className="text-sm text-muted">Upload your resume above. If it lists your theory, practical or safety marks, you can confirm them here.</p>
        ) : !hasMarks ? (
          <p className="text-sm text-muted">No assessment marks were found in your latest resume.</p>
        ) : (
          <ReportedMarksForm key={`${r.id}:${me.updated_at}`} me={me} resume={r} />
        )}
      </div>
    </Card>
  );
}

/** The Profile page body (ADR-024): resume first (it fills skills and interest), then the editable profile. */
export function ProfileSection({ me }: { me: TraineeMe }) {
  return (
    <section id="profile" aria-label="My profile" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:items-start">
      <ManagedRecord me={me} />
      <div className="min-w-0 space-y-6">
        <ResumePanel me={me} />
        <ProfileForm key={me.updated_at} me={me} />
        <ReportedMarksCard me={me} />
      </div>
    </section>
  );
}
