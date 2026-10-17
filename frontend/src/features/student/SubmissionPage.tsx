import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Submission } from "@/api/types";
import { uploadMultipart } from "@/api/upload";
import { EmptyState, ErrorState, FileField, FormField, LoadingState, PageHeader, useToast } from "@/components/shared";
import { Alert, Button, Card, Input, Textarea } from "@/components/ui";
import { SubmissionDetailView } from "@/features/shared/views";

import { AllocationPanel, NoAllocationPanel } from "./AllocationPanel";
import {
  ARTIFACT_REQUIRED, FILE_ACCEPT, MAX_FILE_BYTES, buildSubmissionFormData, emptySubmission, submissionSchema,
  submitBlockedReason, type SubmissionValues,
} from "./forms";
import { useMySubmissionHistory, useStudentContext } from "./hooks";

const FIELDS = ["video_url", "report_url", "file", "logbook_hours", "bom_cost_inr", "note"] as const;
type FieldKey = (typeof FIELDS)[number];

/** Form-level alert text for SUB-01 409 codes (student.md §9.3). */
const CONFLICT_TEXT: Record<string, string> = {
  NO_ACTIVE_CYCLE: "No allocation cycle is open.",
  INVALID_STATE: "Allocations are not published yet.",
  NOT_ALLOCATED: "You have no allocated project.",
  SUBMISSION_PENDING: "A version is already awaiting evaluation.",
  SUBMISSION_ALREADY_EVALUATED: "Your project has been evaluated; no further versions are accepted.",
  NO_TRAINEE_RECORD: "Your trainee record is not linked.",
};

function SubmitForm({ nextVersion, late }: { nextVersion: number; late: boolean }) {
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
        if (e.code === "NO_ACTIVE_CYCLE") void qc.invalidateQueries({ queryKey: qk.cycles.current() });
        if (e.code === "INVALID_STATE") void qc.invalidateQueries({ queryKey: qk.cycles.current() });
        if (["NO_TRAINEE_RECORD", "NOT_ALLOCATED", "INVALID_STATE"].includes(e.code))
          void qc.invalidateQueries({ queryKey: qk.trainees.me() });
        if (["SUBMISSION_PENDING", "SUBMISSION_ALREADY_EVALUATED"].includes(e.code))
          void qc.invalidateQueries({ queryKey: qk.submissions.all() });
        return;
      }
      setFormAlert({ text: errorMessage(e), requestId: e.requestId });
    },
    onSettled: () => setProgress(null),
  });

  return (
    <Card title={nextVersion === 1 ? "Submit your work" : `Submit version ${nextVersion}`}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={handleSubmit((v) => {
          setFormAlert(null);
          submit.mutate(v);
        })}
      >
        {late && <Alert variant="warning">The deadline has passed. Your submission will be accepted but marked Late.</Alert>}
        <p className="text-sm text-muted">{ARTIFACT_REQUIRED}</p>
        <FormField label="Video link" htmlFor="video_url" error={errors.video_url?.message} hint="A public https:// link, e.g. YouTube or Google Drive">
          <Input id="video_url" type="url" inputMode="url" placeholder="https://" maxLength={2048} {...register("video_url")} />
        </FormField>
        <FormField label="Report link" htmlFor="report_url" error={errors.report_url?.message}>
          <Input id="report_url" type="url" inputMode="url" placeholder="https://" maxLength={2048} {...register("report_url")} />
        </FormField>
        <FormField label="Report file" htmlFor="file" hint="Up to 10 MB: pdf, docx, pptx, zip, png, jpg">
          <FileField
            key={fileKey}
            id="file"
            accept={FILE_ACCEPT}
            maxBytes={MAX_FILE_BYTES}
            error={errors.file?.message}
            onChange={(f) => setValue("file", f, { shouldValidate: true })}
          />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Logbook hours" htmlFor="logbook_hours" error={errors.logbook_hours?.message} hint="0 to 1000">
            <Input id="logbook_hours" type="number" inputMode="decimal" min={0} max={1000} step="0.1" {...register("logbook_hours")} />
          </FormField>
          <FormField label="Bill of materials cost (INR)" htmlFor="bom_cost_inr" error={errors.bom_cost_inr?.message} hint="0 to 1,00,00,000">
            <Input id="bom_cost_inr" type="number" inputMode="decimal" min={0} max={10_000_000} step="0.01" {...register("bom_cost_inr")} />
          </FormField>
        </div>
        <FormField label="Note to your supervisor" htmlFor="note" error={errors.note?.message} hint={`${form.watch("note").length} / 2000`}>
          <Textarea id="note" rows={3} maxLength={2000} {...register("note")} />
        </FormField>
        {errors.root?.message && <Alert variant="danger">{errors.root.message}</Alert>}
        {formAlert && (
          <Alert variant="danger">
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
        <div>
          <Button type="submit" loading={submit.isPending} className="w-full sm:w-auto">
            Submit version {nextVersion}
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function SubmissionPage() {
  const { cycle, me } = useStudentContext();
  const history = useMySubmissionHistory();
  if (!cycle || !me) return <LoadingState />;

  const versions = history.data?.data ?? [];
  const latest = versions[0];
  const blocked = submitBlockedReason(cycle, me, latest);
  const late = Date.now() > new Date(cycle.submission_deadline).getTime();

  return (
    <div>
      <PageHeader title="My project & submission" description="Your allocated project, your submitted work and your supervisor's evaluation." />
      <div className="flex flex-col gap-4">
        {me.allocation ? <AllocationPanel allocation={me.allocation} cycle={cycle} defaultOpen /> : <NoAllocationPanel cycle={cycle} />}

        {history.isLoading ? (
          <LoadingState />
        ) : history.error ? (
          <ErrorState error={history.error} onRetry={() => history.refetch()} />
        ) : (
          <>
            {latest?.status === "rework_requested" && (
              <Alert variant="warning" title={`Rework requested on version ${latest.version}`}>
                <span className="whitespace-pre-wrap">{latest.evaluation?.feedback ?? "Your supervisor asked for changes. Submit a new version."}</span>
              </Alert>
            )}
            {blocked ? (
              me.allocation && (
                <Card title="Submit your work">
                  <p className="text-sm text-muted" role="status">{blocked}</p>
                </Card>
              )
            ) : (
              <SubmitForm nextVersion={(latest?.version ?? 0) + 1} late={late} />
            )}
            {latest ? (
              <section aria-label="Latest version">
                <SubmissionDetailView submission={latest} history={versions} historyHref={(s) => `/student/submissions/${s.id}`} />
              </section>
            ) : (
              me.allocation && <EmptyState title="You have not submitted yet" description="Your submitted versions and feedback will appear here." />
            )}
          </>
        )}
      </div>
    </div>
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
  if (sub.error || !s) return <ErrorState error={sub.error} onRetry={() => sub.refetch()} />;
  const versions = (history.data?.data ?? []).filter((h) => h.allocation_id === s.allocation_id);

  return (
    <div>
      <PageHeader
        title={`Submission · version ${s.version}`}
        description={`${s.project.project_code} · ${s.project.title}`}
        actions={<Link className="text-sm text-primary underline" to="/student/submission">Back to My project</Link>}
      />
      {s.status === "rework_requested" && s.evaluation?.feedback && (
        <div className="mb-4">
          <Alert variant="warning" title="Rework requested">
            <span className="whitespace-pre-wrap">{s.evaluation.feedback}</span>
          </Alert>
        </div>
      )}
      <SubmissionDetailView submission={s} history={versions} historyHref={(x) => `/student/submissions/${x.id}`} />
      {history.error && (
        <div className="mt-4">
          <ErrorState error={history.error} onRetry={() => history.refetch()} />
        </div>
      )}
    </div>
  );
}
