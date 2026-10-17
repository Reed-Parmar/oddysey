import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm, type Path } from "react-hook-form";
import { Link, useParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Cycle, EvaluationIn, Submission } from "@/api/types";
import {
  ConfirmDialog, ErrorState, FormError, FormField, LoadingState, NotFound, PageHeader, StatusBadge, useToast,
} from "@/components/shared";
import { Alert, Button, Card, Input, Textarea } from "@/components/ui";
import { CRITERIA, SubmissionDetailView } from "@/features/shared/views";
import { label } from "@/lib/statusLabels";

import { useCycleState } from "../common";
import {
  computeTotal, emptyEvaluationForm, evaluationFormSchema, FEEDBACK_MAX, gradeFor, toEvaluationBody,
  type EvaluationFormValues,
} from "../lib/grade";

function EvaluationReasonPanel({ submission, cycle }: { submission: Submission; cycle: Cycle | null }) {
  let text: string;
  if (submission.status === "evaluated") text = "This version has been evaluated. Evaluations are final.";
  else if (submission.status === "rework_requested") text = "Rework was requested. The trainee's next version will appear here.";
  else if (!cycle || cycle.id !== submission.cycle_id) text = "Evaluations are closed because this submission belongs to a cycle that is no longer active.";
  else text = `Evaluations are closed because the cycle is ${label("cycle", cycle.status)[0].toLowerCase()}.`;
  return <Alert variant="info">{text}</Alert>;
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

  return (
    <Card title="Evaluate this version">
      <form noValidate onSubmit={handleSubmit(onValid)} className="flex flex-col gap-4">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Outcome <span className="text-danger" aria-hidden>*</span></legend>
          <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
            <label className="flex min-h-10 items-center gap-2 text-sm"><input type="radio" value="evaluated" {...register("outcome")} /> Evaluated (final)</label>
            <label className="flex min-h-10 items-center gap-2 text-sm"><input type="radio" value="rework_requested" {...register("outcome")} /> Request rework</label>
          </div>
          {errors.outcome && <p className="text-xs text-danger" role="alert">{errors.outcome.message}</p>}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {CRITERIA.map(([k, name, max]) => (
            <FormField key={k} label={`${name} (/${max})`} htmlFor={`score-${k}`} required={outcome === "evaluated"} error={errors.scores?.[k]?.message}>
              <Input id={`score-${k}`} type="number" inputMode="numeric" min={0} max={max} step={1}
                aria-invalid={Boolean(errors.scores?.[k]) || undefined} {...register(`scores.${k}`)} />
            </FormField>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 rounded-md bg-neutral-bg px-3 py-2 text-sm" aria-live="polite">
          {total == null ? <span>Total — <span className="text-muted">(enter all five scores)</span></span> : (
            <><span className="font-semibold">Total {total} / 100</span><StatusBadge kind="grade" value={gradeFor(total)} /><span className="text-xs text-muted">Preview — the saved grade is computed by the server.</span></>
          )}
        </div>

        <FormField label="Feedback" htmlFor="eval-feedback" required={outcome === "rework_requested"} error={errors.feedback?.message}
          hint={outcome === "rework_requested" ? "Tell the trainee what to fix (at least 10 characters)." : "Optional."}>
          <Textarea id="eval-feedback" rows={5} maxLength={FEEDBACK_MAX} aria-invalid={Boolean(errors.feedback) || undefined} {...register("feedback")} />
          <p className="text-right text-xs text-muted">{feedback.length} / {FEEDBACK_MAX}</p>
        </FormField>

        {unmapped && <FormError error={m.error} />}

        <div className="flex justify-end">
          <Button type="submit" loading={m.isPending} variant={outcome === "evaluated" ? "primary" : "secondary"}>
            {outcome === "evaluated" ? "Submit final evaluation" : "Request rework"}
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
        title={`${s.trainee.full_name} · v${s.version}`}
        description={<span className="flex flex-wrap gap-3">
          <Link className="text-primary underline" to="/supervisor/submissions">Back to evaluations</Link>
          <Link className="text-primary underline" to={`/supervisor/trainees/${s.trainee.id}`}>Trainee profile</Link>
        </span>}
      />
      {history.error && <div className="mb-3"><ErrorState error={history.error} onRetry={() => void history.refetch()} /></div>}
      <SubmissionDetailView
        submission={s}
        history={history.data?.data}
        historyHref={(x) => `/supervisor/submissions/${x.id}`}
        actions={canEvaluate
          ? <EvaluationForm key={s.id} submission={s} onDone={() => void sub.refetch()} />
          : <EvaluationReasonPanel submission={s} cycle={cycle} />}
      />
      {cycleState.error && <p className="mt-3 text-sm text-danger">Could not load the cycle status: {errorMessage(cycleState.error)}</p>}
    </>
  );
}
