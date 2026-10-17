import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowCounterClockwise, Exam, Info, LockKey, SealCheck, UserCircle, WarningCircle,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useForm, type Path } from "react-hook-form";
import { Link, useParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Cycle, EvaluationIn, Submission } from "@/api/types";
import {
  BackLink, ConfirmDialog, ErrorState, FormError, FormField, LoadingState, NotFound, PageHeader, StatusBadge, useToast,
} from "@/components/shared";
import { Alert, Button, Card, Input, Textarea, buttonStyles, cx } from "@/components/ui";
import { CRITERIA, SubmissionDetailView } from "@/features/shared/views";
import { label } from "@/lib/statusLabels";

import { useCycleState } from "../common";
import {
  computeTotal, emptyEvaluationForm, evaluationFormSchema, FEEDBACK_MAX, gradeFor, parseScore, toEvaluationBody,
  type EvaluationFormValues, type Grade,
} from "../lib/grade";

function EvaluationReasonPanel({ submission, cycle }: { submission: Submission; cycle: Cycle | null }) {
  let text: string;
  let icon: ReactNode = <LockKey />;
  if (submission.status === "evaluated") { text = "This version has been evaluated. Evaluations are final."; icon = <SealCheck />; }
  else if (submission.status === "rework_requested") { text = "Rework was requested. The trainee's next version will appear here."; icon = <ArrowCounterClockwise />; }
  else if (!cycle || cycle.id !== submission.cycle_id) text = "Evaluations are closed because this submission belongs to a cycle that is no longer active.";
  else text = `Evaluations are closed because the cycle is ${label("cycle", cycle.status)[0].toLowerCase()}.`;
  return <Alert variant="info" icon={icon}>{text}</Alert>;
}

/** Bar colour for the live total, by grade band (always shown next to the number and grade text). */
const GRADE_BAR: Record<Grade, string> = {
  A1: "bg-success", A: "bg-success", "B+": "bg-primary", B: "bg-primary", C: "bg-warning", D: "bg-danger",
};

/** Selectable-card radio: a real <input type="radio"> wrapped by its <label>. */
function OutcomeOption({ title, hint, icon, input }: { title: string; hint: string; icon: ReactNode; input: ReactNode }) {
  return (
    <label className={cx(
      "flex min-h-16 cursor-pointer items-start gap-3 rounded-xl border border-border-strong bg-surface p-3.5 transition-colors duration-150",
      "hover:border-subtle has-[:checked]:border-primary has-[:checked]:bg-primary-soft has-[:checked]:ring-1 has-[:checked]:ring-primary",
    )}>
      {input}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-semibold text-text">
          <span aria-hidden className="text-primary [&>svg]:size-4">{icon}</span>
          {title}
        </span>
        <span className="mt-0.5 block text-xs text-muted">{hint}</span>
      </span>
    </label>
  );
}

function EvaluationForm({ submission, onDone }: { submission: Submission; onDone: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState<EvaluationIn | null>(null);
  const form = useForm<EvaluationFormValues>({ resolver: zodResolver(evaluationFormSchema), defaultValues: emptyEvaluationForm(), mode: "onTouched" });
  const { register, handleSubmit, watch, setError, formState: { errors } } = form;
  const outcome = watch("outcome");
  const scores = watch("scores");
  const feedback = watch("feedback");
  const total = computeTotal(scores);

  const m = useMutation({
    mutationFn: (body: EvaluationIn) => call(api.POST("/api/v1/submissions/{submission_id}/evaluation", {
      params: { path: { submission_id: submission.id } }, body,
    })),
    onSuccess: (res, body) => {
      setConfirm(null);
      qc.setQueryData(qk.submissions.detail(submission.id), res);
      void qc.invalidateQueries({ queryKey: qk.submissions.all() });
      void qc.invalidateQueries({ queryKey: qk.progress.all() });
      toast.success(body.outcome === "evaluated" ? "Evaluation saved" : "Rework requested");
    },
    onError: (e) => {
      setConfirm(null);
      if (e instanceof ApiError && e.status === 409) {
        toast.error(e.code === "SUBMISSION_ALREADY_EVALUATED" ? "This version was already evaluated" : e.message);
        void qc.invalidateQueries({ queryKey: qk.cycles.current() });
        onDone();
        return;
      }
      if (e instanceof ApiError && e.status === 422) {
        const fe = e.fieldErrors();
        for (const [field, message] of Object.entries(fe)) {
          if (field === "outcome" || field === "feedback" || CRITERIA.some(([k]) => field === `scores.${k}`)) {
            setError(field as Path<EvaluationFormValues>, { type: "server", message });
          }
        }
      }
    },
  });

  const unmapped = m.error instanceof ApiError && m.error.status === 422
    ? Object.keys(m.error.fieldErrors()).some((f) => !(f === "outcome" || f === "feedback" || f.startsWith("scores.")))
    : m.error && !(m.error instanceof ApiError && m.error.status === 409);

  const onValid = (v: EvaluationFormValues) => {
    const body = toEvaluationBody(v);
    if (body.outcome === "evaluated") setConfirm(body);
    else m.mutate(body);
  };

  // Display-only: how many criteria hold a valid in-range score (drives the per-row bars and the "x of 5" hint).
  const valid = (k: (typeof CRITERIA)[number][0], max: number) => {
    const n = parseScore(scores[k] ?? "");
    return n !== null && !Number.isNaN(n) && n <= max ? n : null;
  };
  const scoredCount = CRITERIA.filter(([k, , max]) => valid(k, max) !== null).length;
  const grade = total == null ? null : gradeFor(total);
  const final = outcome === "evaluated";

  return (
    <Card icon={<Exam />} title="Evaluate this version" description="Rubric: five criteria, 100 points in total.">
      <form noValidate onSubmit={handleSubmit(onValid)} className="flex flex-col gap-6">
        <fieldset>
          <legend className="mb-2 text-sm font-semibold text-text">Outcome <span className="text-danger" aria-hidden>*</span></legend>
          <div className="grid gap-2 sm:grid-cols-2">
            <OutcomeOption
              title="Evaluated (final)"
              hint="Score all five criteria. This closes the submission."
              icon={<SealCheck />}
              input={<input type="radio" value="evaluated" className="mt-0.5 size-4 shrink-0 accent-primary" {...register("outcome")} />}
            />
            <OutcomeOption
              title="Request rework"
              hint="Send it back with notes. The trainee submits a new version."
              icon={<ArrowCounterClockwise />}
              input={<input type="radio" value="rework_requested" className="mt-0.5 size-4 shrink-0 accent-primary" {...register("outcome")} />}
            />
          </div>
          {errors.outcome && <p className="mt-1 text-xs font-medium text-danger" role="alert">{errors.outcome.message}</p>}
        </fieldset>

        <fieldset>
          <legend className="mb-2 flex w-full items-baseline justify-between gap-2 text-sm font-semibold text-text">
            <span>Rubric scores</span>
            <span className="text-xs font-normal text-muted tabular-nums">{scoredCount} of {CRITERIA.length} scored{!final && " · optional for rework"}</span>
          </legend>
          <ul className="divide-y divide-border rounded-xl border border-border">
            {CRITERIA.map(([k, name, max]) => {
              const n = valid(k, max);
              const err = errors.scores?.[k]?.message;
              const errId = `score-${k}-error`;
              return (
                <li key={k} className="px-3.5 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <label htmlFor={`score-${k}`} className="min-w-0 text-sm font-medium text-text">
                      {name}
                      {final && <span className="text-danger" aria-hidden> *</span>}
                      <span className="block text-xs font-normal text-muted">Out of {max} points</span>
                    </label>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <Input id={`score-${k}`} type="number" inputMode="numeric" min={0} max={max} step={1}
                        className="w-20 text-right font-semibold tabular-nums"
                        aria-invalid={Boolean(errors.scores?.[k]) || undefined}
                        aria-describedby={err ? errId : undefined}
                        {...register(`scores.${k}`)} />
                      <span aria-hidden className="w-8 text-sm text-muted tabular-nums">/ {max}</span>
                    </div>
                  </div>
                  <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-neutral-bg">
                    <div className="h-full rounded-full bg-primary transition-[width] duration-200" style={{ width: `${n == null ? 0 : (n / max) * 100}%` }} />
                  </div>
                  {err && (
                    <p id={errId} className="mt-1.5 flex items-center gap-1 text-xs font-medium text-danger" role="alert">
                      <WarningCircle aria-hidden size={14} className="shrink-0" />{err}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </fieldset>

        <div className="rounded-xl border border-primary/20 bg-primary-soft p-4" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-heading text-2xl font-semibold tracking-tight text-text tabular-nums">
              <span>{total == null ? "Total — / 100" : `Total ${total} / 100`}</span>
            </p>
            {grade && <StatusBadge kind="grade" value={grade} />}
          </div>
          <div aria-hidden className="mt-3 h-2 overflow-hidden rounded-full bg-surface">
            <div className={cx("h-full rounded-full transition-[width] duration-200", grade ? GRADE_BAR[grade] : "bg-primary")} style={{ width: `${total ?? 0}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted">
            {total == null
              ? "Enter all five scores to see the total and grade."
              : "Grade preview. The saved grade is computed by the server."}
          </p>
        </div>

        <FormField label="Feedback" htmlFor="eval-feedback" required={outcome === "rework_requested"} error={errors.feedback?.message}
          hint={outcome === "rework_requested"
            ? "Tell the trainee what to fix (at least 10 characters). They will see this with their submission."
            : "Optional. Shown to the trainee with their result."}>
          <Textarea id="eval-feedback" rows={5} maxLength={FEEDBACK_MAX} aria-invalid={Boolean(errors.feedback) || undefined} {...register("feedback")} />
          <p className="text-right text-xs text-muted tabular-nums">{feedback.length} / {FEEDBACK_MAX}</p>
        </FormField>

        {unmapped && <FormError error={m.error} />}

        <div className="flex flex-col-reverse gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted">
            {final ? "You will confirm before the evaluation is saved. It cannot be changed afterwards." : "The trainee is notified and can submit a new version."}
          </p>
          <Button type="submit" size="lg" className="w-full sm:w-auto" loading={m.isPending} variant={final ? "primary" : "secondary"}
            icon={final ? <SealCheck /> : <ArrowCounterClockwise />}>
            {final ? "Submit final evaluation" : "Request rework"}
          </Button>
        </div>
      </form>
      <ConfirmDialog
        open={confirm !== null}
        title="Submit final evaluation?"
        message={<>This evaluation is final. The trainee cannot submit again.{total != null && <> Total <strong>{total} / 100</strong> (grade preview {gradeFor(total)}).</>}</>}
        confirmLabel="Submit evaluation"
        loading={m.isPending}
        onConfirm={() => confirm && m.mutate(confirm)}
        onClose={() => { if (!m.isPending) setConfirm(null); }}
      />
    </Card>
  );
}

export function SubmissionDetailPage() {
  const { submissionId = "" } = useParams();
  const cycleState = useCycleState();
  const sub = useQuery({
    queryKey: qk.submissions.detail(submissionId),
    queryFn: () => call(api.GET("/api/v1/submissions/{submission_id}", { params: { path: { submission_id: submissionId } } })),
  });
  const s = sub.data?.data;
  const hq = s ? { cycle_id: s.cycle_id, trainee_id: s.trainee.id, latest_only: false, sort: "submitted_at", page_size: 100 } : undefined;
  const history = useQuery({
    queryKey: qk.submissions.list(hq),
    queryFn: () => call(api.GET("/api/v1/submissions", { params: { query: hq } })),
    enabled: Boolean(hq),
  });

  if (sub.isLoading || cycleState.isLoading) return <LoadingState />;
  if (sub.error) return <ErrorState error={sub.error} onRetry={() => void sub.refetch()} />;
  if (!s) return <NotFound />;

  const cycle = cycleState.cycle;
  const canEvaluate = s.status === "submitted" && cycle?.status === "published" && cycle.id === s.cycle_id;

  return (
    <>
      <PageHeader
        eyebrow={<BackLink to="/supervisor/submissions">Back to evaluations</BackLink>}
        title={`${s.trainee.full_name} · v${s.version}`}
        description={<span className="inline-flex flex-wrap items-center gap-2">{s.project.project_code} · {s.project.title}</span>}
        actions={
          <Link className={buttonStyles("secondary")} to={`/supervisor/trainees/${s.trainee.id}`}>
            <UserCircle aria-hidden size={16} /> Trainee profile
          </Link>
        }
      />
      {history.error && <div className="mb-4"><ErrorState error={history.error} onRetry={() => void history.refetch()} /></div>}
      {canEvaluate ? (
        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
          <div className="min-w-0 space-y-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold tracking-wide text-muted uppercase">
              <Info aria-hidden size={16} /> Submission evidence
            </h2>
            <SubmissionDetailView submission={s} history={history.data?.data} historyHref={(x) => `/supervisor/submissions/${x.id}`} />
          </div>
          <div className="min-w-0 lg:sticky lg:top-6">
            <EvaluationForm key={s.id} submission={s} onDone={() => void sub.refetch()} />
          </div>
        </div>
      ) : (
        <div className="max-w-4xl">
          <SubmissionDetailView
            submission={s}
            history={history.data?.data}
            historyHref={(x) => `/supervisor/submissions/${x.id}`}
            actions={<EvaluationReasonPanel submission={s} cycle={cycle} />}
          />
        </div>
      )}
      {cycleState.error && <p className="mt-3 text-sm text-danger">Could not load the cycle status: {errorMessage(cycleState.error)}</p>}
    </>
  );
}
