/** Submission pieces for My Project (SUB-01/02) and the own submission detail page. */
import {
  ChatCircleText, ClockCounterClockwise, Files, Hourglass, Info, MagnifyingGlass, PaperPlaneTilt, Ruler, WarningCircle,
} from "@phosphor-icons/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { Link, useParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Submission } from "@/api/types";
import { uploadMultipart } from "@/api/upload";
import {
  BackLink, DateTime, ErrorState, FileField, FormField, LoadingState, PageHeader, StatusBadge, useToast,
} from "@/components/shared";
import { Alert, Button, Card, Input, Textarea, cx } from "@/components/ui";
import { AnalysisReport, ReportScore, SubmissionDetailView, useAnalysis } from "@/features/shared/views";

import {
  FILE_ACCEPT, MAX_FILE_BYTES, REPORT_REQUIRED, buildSubmissionFormData, emptySubmission, reworkMessage, submissionSchema,
  type SubmissionValues,
} from "./forms";

const FIELDS = ["video_url", "report_url", "file", "logbook_hours", "bom_cost_inr", "note"] as const;
type FieldKey = (typeof FIELDS)[number];

/** Form-level alert text for SUB-01 409 codes (student.md §9.3). */
const CONFLICT_TEXT: Record<string, string> = {
  NO_ACTIVE_CYCLE: "No programme cycle is open.",
  INVALID_STATE: "This cycle is archived; submissions are closed.",
  NOT_ALLOCATED: "You have no allocated project.",
  SUBMISSION_PENDING: "A version is already awaiting evaluation.",
  SUBMISSION_ALREADY_EVALUATED: "Your project has been evaluated; no further versions are accepted.",
  NO_TRAINEE_RECORD: "Your trainee record is not linked.",
};

/** A titled group of form fields. */
function FieldGroup({ legend, description, icon, children }: { legend: string; description?: ReactNode; icon: ReactNode; children: ReactNode }) {
  return (
    <fieldset className="min-w-0 rounded-lg border border-border p-4">
      <legend className="flex items-center gap-1.5 px-1 text-sm font-semibold text-text">
        <span aria-hidden className="inline-flex text-primary [&>svg]:size-4">{icon}</span>
        {legend}
      </legend>
      {description && <p className="-mt-1 mb-3 text-xs text-muted">{description}</p>}
      <div className="flex flex-col gap-4">{children}</div>
    </fieldset>
  );
}

/** The rules a trainee needs before submitting (mirrors the server; UX only). */
export function SubmissionRules() {
  return (
    <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
      <li>A report is required: a report link, or a PDF/DOCX report file. A video alone is not enough.</li>
      <li>PPTX, ZIP and image files are accepted only as supplements when you also give a report link.</li>
      <li>While a version is awaiting evaluation you can't submit another one.</li>
      <li>If rework is requested, you can submit a new version. An evaluated project is final.</li>
    </ul>
  );
}

export function SubmitForm({ nextVersion, late }: { nextVersion: number; late: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [progress, setProgress] = useState<number | null>(null);
  const [formAlert, setFormAlert] = useState<{ text: string; requestId?: string | null } | null>(null);
  const [fileKey, setFileKey] = useState(0);
  const form = useForm<SubmissionValues>({ resolver: zodResolver(submissionSchema), defaultValues: emptySubmission });
  const { register, handleSubmit, setValue, setError, formState: { errors } } = form;

  const submit = useMutation({
    mutationFn: (v: SubmissionValues) =>
      uploadMultipart<{ data: Submission }>("/submissions", buildSubmissionFormData(v), { onProgress: setProgress }),
    onSuccess: async (res) => {
      toast.success(`Version ${res.data.version} submitted`);
      form.reset(emptySubmission);
      setFileKey((k) => k + 1);
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.submissions.all() }),
        qc.invalidateQueries({ queryKey: qk.progress.all() }),
      ]);
    },
    onError: (e) => {
      if (!(e instanceof ApiError)) {
        setFormAlert({ text: errorMessage(e) });
        return;
      }
      if (e.code === "FILE_TOO_LARGE" || e.code === "UNSUPPORTED_FILE_TYPE" || e.status === 413 || e.status === 415) {
        setError("file", { message: e.details.find((d) => d.field.endsWith("file"))?.message ?? e.message });
        return;
      }
      if (e.code === "REPORT_REQUIRED") {
        setFormAlert({ text: REPORT_REQUIRED });
        return;
      }
      if (e.status === 422) {
        const unmapped: string[] = [];
        for (const [f, msg] of Object.entries(e.fieldErrors())) {
          if ((FIELDS as readonly string[]).includes(f)) setError(f as FieldKey, { message: msg });
          else unmapped.push(msg);
        }
        if (unmapped.length || !e.details.length) setFormAlert({ text: unmapped.join("; ") || e.message });
        return;
      }
      if (e.code in CONFLICT_TEXT) {
        setFormAlert({ text: CONFLICT_TEXT[e.code] });
        if (e.code === "NO_ACTIVE_CYCLE" || e.code === "INVALID_STATE") void qc.invalidateQueries({ queryKey: qk.cycles.current() });
        if (["NO_TRAINEE_RECORD", "NOT_ALLOCATED"].includes(e.code)) void qc.invalidateQueries({ queryKey: qk.trainees.me() });
        if (["SUBMISSION_PENDING", "SUBMISSION_ALREADY_EVALUATED"].includes(e.code))
          void qc.invalidateQueries({ queryKey: qk.submissions.all() });
        return;
      }
      setFormAlert({ text: errorMessage(e), requestId: e.requestId });
    },
    onSettled: () => setProgress(null),
  });

  return (
    <Card
      title={nextVersion === 1 ? "Submit your work" : `Submit version ${nextVersion}`}
      description="Your report gets an automated report score with feedback. Your supervisor may also record a verified practical evaluation."
      icon={<PaperPlaneTilt />}
    >
      <form
        noValidate
        className="flex flex-col gap-5"
        onSubmit={handleSubmit((v) => {
          setFormAlert(null);
          submit.mutate(v);
        })}
      >
        {late && <Alert variant="warning" icon={<WarningCircle />}>The deadline has passed. Your submission will be accepted but marked Late.</Alert>}
        <FieldGroup legend="Your report (required)" description="Give a report link, or upload your report as a PDF or DOCX." icon={<Files />}>
          <FormField label="Report link" htmlFor="report_url" error={errors.report_url?.message} hint="A shared document link starting with https://">
            <Input id="report_url" type="url" inputMode="url" placeholder="https://" maxLength={2048} {...register("report_url")} />
          </FormField>
          <FormField
            label="Report file or supplement"
            htmlFor="file"
            hint="Up to 10 MB. PDF or DOCX counts as your report; PPTX, ZIP, PNG or JPG only as a supplement next to a report link."
          >
            <FileField
              key={fileKey}
              id="file"
              accept={FILE_ACCEPT}
              maxBytes={MAX_FILE_BYTES}
              error={errors.file?.message}
              onChange={(f) => setValue("file", f, { shouldValidate: true })}
            />
          </FormField>
          <FormField label="Video link (optional)" htmlFor="video_url" error={errors.video_url?.message} hint="A public https:// link, e.g. YouTube or Google Drive">
            <Input id="video_url" type="url" inputMode="url" placeholder="https://" maxLength={2048} {...register("video_url")} />
          </FormField>
        </FieldGroup>
        <FieldGroup legend="Project log" description="Optional, but it helps your supervisor." icon={<Ruler />}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Logbook hours" htmlFor="logbook_hours" error={errors.logbook_hours?.message} hint="0 to 1000">
              <Input id="logbook_hours" type="number" inputMode="decimal" min={0} max={1000} step="0.1" {...register("logbook_hours")} />
            </FormField>
            <FormField label="Bill of materials cost (INR)" htmlFor="bom_cost_inr" error={errors.bom_cost_inr?.message} hint="0 to 1,00,00,000">
              <Input id="bom_cost_inr" type="number" inputMode="decimal" min={0} max={10_000_000} step="0.01" {...register("bom_cost_inr")} />
            </FormField>
          </div>
        </FieldGroup>
        <FormField label="Note to your supervisor" htmlFor="note" error={errors.note?.message} hint={`${form.watch("note").length} / 2000`}>
          <Textarea id="note" rows={3} maxLength={2000} placeholder="Anything your supervisor should know about this version" {...register("note")} />
        </FormField>
        {errors.root?.message && <Alert variant="danger" icon={<WarningCircle />}>{errors.root.message}</Alert>}
        {formAlert && (
          <Alert variant="danger" icon={<WarningCircle />}>
            {formAlert.text}
            {formAlert.requestId && <span className="mt-1 block text-xs">Request ID: <code className="select-all">{formAlert.requestId}</code></span>}
          </Alert>
        )}
        {progress != null && (
          <div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-bg" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)} aria-label="Upload progress">
              <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <p className="mt-1 text-xs text-muted" aria-live="polite">Uploading… {Math.round(progress * 100)}%</p>
          </div>
        )}
        <div className="flex flex-col gap-3 border-t border-border pt-4">
          <SubmissionRules />
          <Button type="submit" size="lg" loading={submit.isPending} icon={<PaperPlaneTilt />} className="w-full sm:w-auto sm:self-start">
            Submit version {nextVersion}
          </Button>
        </div>
      </form>
    </Card>
  );
}

/** Shown in place of the form when submitting is not possible right now. */
export function SubmitBlocked({ reason, pending }: { reason: string; pending?: boolean }) {
  return (
    <Card title="Submit your work" icon={pending ? <Hourglass /> : <Info />}>
      <p className="text-sm text-muted" role="status">{reason}</p>
      <div className="mt-3"><SubmissionRules /></div>
    </Card>
  );
}

const DOT: Record<Submission["status"], string> = {
  submitted: "bg-info",
  rework_requested: "bg-warning",
  evaluated: "bg-success",
};

/** Vertical list of every version, newest first, with status, analysis status and automated score. */
export function VersionTimeline({ versions, currentId }: { versions: Submission[]; currentId?: string }) {
  return (
    <Card title="Versions" icon={<ClockCounterClockwise />} description={`${versions.length} version${versions.length === 1 ? "" : "s"} submitted`}>
      <ol className="relative ml-1.5 border-l-2 border-border">
        {versions.map((h) => {
          const current = h.id === currentId;
          return (
            <li key={h.id} className="relative pb-5 pl-5 last:pb-0">
              <span aria-hidden className={cx("absolute top-1 -left-[7px] size-3 rounded-full ring-4 ring-surface", DOT[h.status])} />
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-sm font-semibold text-text">
                  Version {h.version}
                  {current && <span className="ml-1.5 text-xs font-medium text-muted">(shown)</span>}
                </p>
                <span className="text-xs text-muted"><DateTime value={h.submitted_at} /></span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <StatusBadge kind="submission" value={h.status} />
                <StatusBadge kind="analysis" value={h.analysis_status} />
                {h.is_late && <StatusBadge kind="late" value="late" />}
                {h.evaluation?.grade && <StatusBadge kind="grade" value={h.evaluation.grade} />}
              </div>
              <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted">Report score:</span>
                <ReportScore summary={h.report_evaluation} />
              </p>
              {!current && (
                <Link className="mt-1 inline-flex min-h-9 items-center text-sm font-semibold text-primary hover:underline" to={`/student/submissions/${h.id}`}>
                  View version {h.version}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

/** Highlighted feedback asking for rework. */
export function ReworkFeedback({ title, feedback }: { title: string; feedback: string }) {
  return (
    <section aria-label="Rework feedback" className="rounded-xl border border-warning/30 bg-warning-bg p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-surface text-warning">
          <ChatCircleText size={20} />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-warning">{title}</h2>
          <blockquote className="mt-2 border-l-2 border-warning/40 pl-3 text-sm leading-relaxed whitespace-pre-wrap text-text [overflow-wrap:anywhere]">
            {feedback}
          </blockquote>
          <p className="mt-2 text-xs text-muted">Make the changes, then submit a new version.</p>
        </div>
      </div>
    </section>
  );
}

/** Rework banner: the student-safe reason from SUB-05 (`rework_reason`, ADR-028), else the feedback / generic text. */
export function ReworkNotice({ submission: s, title }: { submission: Submission; title: string }) {
  const q = useAnalysis(s.id, false);
  const reason = q.data?.data.rework_reason;
  return <ReworkFeedback title={title} feedback={reason ?? reworkMessage(s.evaluation?.feedback)} />;
}

/** Own analysis for one version; polls while the pipeline is running. 404 means it has not been created yet. */
export function AnalysisCard({ submissionId }: { submissionId: string }) {
  const q = useAnalysis(submissionId, true);
  const pending = q.error instanceof ApiError && q.error.status === 404;
  return (
    <Card
      title="Automated report evaluation"
      icon={<MagnifyingGlass />}
      description="An automated report score with feedback and steps to improve. It checks only what your report documents."
    >
      {q.isLoading ? (
        <LoadingState label="Loading analysis…" />
      ) : pending ? (
        <p className="text-sm text-muted" role="status">Analysis pending: your report is queued for automated analysis. This page updates by itself.</p>
      ) : q.error || !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : (
        <AnalysisReport analysis={q.data.data} />
      )}
    </Card>
  );
}

export function SubmissionDetailPage() {
  const { submissionId = "" } = useParams();
  const sub = useQuery({
    queryKey: qk.submissions.detail(submissionId),
    queryFn: () => call(api.GET("/api/v1/submissions/{submission_id}", { params: { path: { submission_id: submissionId } } })),
    enabled: !!submissionId,
  });
  const s = sub.data?.data;
  const historyParams = { latest_only: false, cycle_id: s?.cycle_id, sort: "-submitted_at", page_size: 50 };
  const history = useQuery({
    queryKey: qk.submissions.list(historyParams),
    queryFn: () => call(api.GET("/api/v1/submissions", { params: { query: historyParams } })),
    enabled: !!s,
  });

  if (sub.isLoading) return <LoadingState />;
  if (sub.error || !s) return <ErrorState error={sub.error} onRetry={() => void sub.refetch()} />;
  const versions = (history.data?.data ?? []).filter((h) => h.allocation_id === s.allocation_id);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={<BackLink to="/student/project">Back to My project</BackLink>}
        title={`Submission · version ${s.version}`}
        description={`${s.project.project_code} · ${s.project.title}`}
      />
      {s.status === "rework_requested" && <ReworkNotice submission={s} title="Rework requested" />}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-6">
          <SubmissionDetailView submission={s} />
          <AnalysisCard submissionId={s.id} />
        </div>
        <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-6">
          {versions.length > 1 && <VersionTimeline versions={versions} currentId={s.id} />}
          {history.error && <ErrorState error={history.error} onRetry={() => void history.refetch()} />}
        </div>
      </div>
    </div>
  );
}
