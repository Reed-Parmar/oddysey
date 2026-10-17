/** /student/project: the trainee's own allocated project only (ADR-017). No catalogue, no choice; rejection before work starts. */
import {
  Archive, BookOpen, CalendarBlank, ClockCounterClockwise, EnvelopeSimple, Hourglass, Lightbulb, ProhibitInset,
  UserCircle, WarningCircle,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Allocation, HistoryEntry } from "@/api/types";
import { Avatar, DateTime, EmptyState, ErrorState, FormField, LoadingState, PageHeader, useToast } from "@/components/shared";
import { Alert, Button, Card, Dialog, Textarea } from "@/components/ui";
import { MatchExplanation, ProjectDetailView, ProjectDocumentButton, ProjectGuide, SubmissionDetailView } from "@/features/shared/views";

import {
  REJECT_CONFLICT_TEXT, REJECT_MAX, REJECT_MIN, WAITING_AFTER_REJECT_TEXT, WAITING_TEXT, canReject, lastRejected,
  newIdempotencyKey, rejectReasonError, submitBlockedReason,
} from "./forms";
import { useMyAllocationHistory, useMySubmissionHistory, useProject, useStudentContext } from "./hooks";
import { AnalysisCard, ReworkFeedback, SubmitBlocked, SubmitForm, VersionTimeline } from "./SubmissionPage";
import { Fact } from "./ui";

export function MyProjectPage() {
  const { cycle, me } = useStudentContext();
  const history = useMyAllocationHistory();
  if (!cycle || !me) return <LoadingState />;
  const archived = cycle.status === "archived";
  const rejected = (history.data?.data ?? []).filter((h) => h.allocation.status === "rejected");

  return (
    <div className="space-y-6">
      <PageHeader title="My project" description="Your allocated project, its guide, your submissions and their evaluation." />
      {archived && (
        <Alert variant="info" icon={<Archive />} title="This cycle is archived">
          Everything is kept read-only: you can view your project and results, but you can't submit or reject.
        </Alert>
      )}
      {me.allocation ? (
        <AllocatedProject allocation={me.allocation} rejected={rejected} />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
          <EmptyState
            icon={<Hourglass />}
            title={lastRejected(history.data?.data) ? "Finding a different eligible project" : "We're finding a suitable project for you"}
            description={lastRejected(history.data?.data) ? WAITING_AFTER_REJECT_TEXT : `${WAITING_TEXT} You'll get a notification as soon as it is ready.`}
          />
          <RejectionHistory entries={rejected} loading={history.isLoading} error={history.error} onRetry={() => void history.refetch()} />
        </div>
      )}
    </div>
  );
}

function AllocatedProject({ allocation: a, rejected }: { allocation: Allocation; rejected: HistoryEntry[] }) {
  const { cycle, me } = useStudentContext();
  const project = useProject(a.project.id);
  const subs = useMySubmissionHistory();
  const history = useMyAllocationHistory();

  const versions = (subs.data?.data ?? []).filter((s) => s.allocation_id === a.id);
  const latest = versions[0];
  const deadline = project.data?.data.effective_deadline ?? cycle?.submission_deadline ?? null;
  const late = !!deadline && Date.now() > new Date(deadline).getTime();
  const blocked = submitBlockedReason(cycle, me, latest);
  const rejectable = subs.isSuccess && canReject(cycle, me, versions.length);
  const sup = a.project.supervisor;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
      <div className="flex min-w-0 flex-col gap-6">
        {project.isLoading ? (
          <LoadingState label="Loading your project…" />
        ) : project.error || !project.data ? (
          <ErrorState error={project.error} onRetry={() => void project.refetch()} />
        ) : (
          <>
            <ProjectDetailView project={project.data.data} />
            <Card title="Project guide" icon={<BookOpen />} description="Step-by-step plan prepared from the project document.">
              <ProjectGuide project={project.data.data} />
            </Card>
          </>
        )}

        <section aria-labelledby="submission-title" className="flex flex-col gap-4">
          <h2 id="submission-title" className="font-heading text-xl font-semibold text-text">Submission</h2>
          {subs.isLoading ? (
            <LoadingState />
          ) : subs.error ? (
            <ErrorState error={subs.error} onRetry={() => void subs.refetch()} />
          ) : (
            <>
              {latest?.status === "rework_requested" && (
                <ReworkFeedback
                  title={`Rework requested on version ${latest.version}`}
                  feedback={latest.evaluation?.feedback ?? "The automated report evaluation or your supervisor asked for changes. Read the analysis below, then submit a new version."}
                />
              )}
              {blocked ? <SubmitBlocked reason={blocked} pending={latest?.status === "submitted"} /> : <SubmitForm nextVersion={(latest?.version ?? 0) + 1} late={late} />}
              {latest && (
                <>
                  <SubmissionDetailView submission={latest} />
                  <AnalysisCard submissionId={latest.id} />
                </>
              )}
            </>
          )}
        </section>
      </div>

      <div className="flex min-w-0 flex-col gap-6">
        <Card title="Supervisor and deadline" icon={<UserCircle />}>
          <dl className="flex flex-col gap-4">
            <Fact label="Supervisor">
              {sup ? (
                <span className="flex items-start gap-2.5">
                  <Avatar name={sup.full_name} size="sm" />
                  <span className="min-w-0">
                    <span className="block">
                      {sup.full_name}
                      {sup.department && <span className="font-normal text-muted"> · {sup.department}</span>}
                    </span>
                    <a className="inline-flex min-h-9 items-center gap-1 font-normal break-all text-primary hover:underline" href={`mailto:${sup.email}`}>
                      <EnvelopeSimple aria-hidden size={14} className="shrink-0" />
                      {sup.email}
                    </a>
                  </span>
                </span>
              ) : (
                <span className="text-muted">A supervisor is being assigned</span>
              )}
            </Fact>
            <Fact label="Submission deadline" icon={<CalendarBlank />}>
              {deadline ? <DateTime value={deadline} /> : "—"}
              {late && !latest && <span className="mt-1 block text-xs font-medium text-warning">The deadline has passed; late submissions are marked Late.</span>}
            </Fact>
            {project.data && (
              <Fact label="Project document">
                <ProjectDocumentButton project={project.data.data} />
              </Fact>
            )}
          </dl>
        </Card>

        <Card title="Why this project was allocated to me" icon={<Lightbulb />}>
          <MatchExplanation allocation={a} />
        </Card>

        {rejectable && <RejectCard allocation={a} />}

        {versions.length > 0 && <VersionTimeline versions={versions} currentId={latest?.id} />}

        {(rejected.length > 0 || history.error) && (
          <RejectionHistory entries={rejected} loading={history.isLoading} error={history.error} onRetry={() => void history.refetch()} />
        )}
      </div>
    </div>
  );
}

function RejectCard({ allocation }: { allocation: Allocation }) {
  const [open, setOpen] = useState(false);
  const [session, setSession] = useState(0);
  return (
    <Card title="Not the right project?" icon={<ProhibitInset />}>
      <p className="text-sm text-muted">
        Before you submit any work, you can reject this project once. A different eligible project is then found for you automatically.
      </p>
      <Button
        variant="secondary"
        className="mt-3"
        icon={<ProhibitInset />}
        onClick={() => {
          setSession((s) => s + 1);
          setOpen(true);
        }}
      >
        Reject this project
      </Button>
      {open && <RejectDialog key={session} allocation={allocation} onClose={() => setOpen(false)} />}
    </Card>
  );
}

function RejectDialog({ allocation: a, onClose }: { allocation: Allocation; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  // One key per dialog opening (this component remounts per opening); reused on retry.
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const reasonError = rejectReasonError(reason);

  const reject = useMutation({
    mutationFn: () =>
      call(api.POST("/api/v1/allocations/{allocation_id}/reject", {
        params: { path: { allocation_id: a.id } },
        body: { reason: reason.trim(), idempotency_key: idempotencyKey },
      })),
    onSuccess: async (res) => {
      toast.success(res.data.message);
      onClose();
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.trainees.me() }),
        qc.invalidateQueries({ queryKey: qk.allocationHistory.all() }),
        qc.invalidateQueries({ queryKey: qk.projects.all() }),
        qc.invalidateQueries({ queryKey: qk.progress.all() }),
        qc.invalidateQueries({ queryKey: qk.notifications.me() }),
      ]);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code in REJECT_CONFLICT_TEXT) {
        setProblem(REJECT_CONFLICT_TEXT[e.code]);
        void qc.invalidateQueries({ queryKey: qk.trainees.me() });
        void qc.invalidateQueries({ queryKey: qk.submissions.all() });
        return;
      }
      setProblem(errorMessage(e));
    },
  });

  return (
    <Dialog
      open
      onClose={() => !reject.isPending && onClose()}
      title="Reject this project?"
      description={`${a.project.project_code} · ${a.project.title}`}
      footer={
        <>
          <Button variant="secondary" disabled={reject.isPending} onClick={onClose}>Keep this project</Button>
          <Button
            variant="danger"
            loading={reject.isPending}
            onClick={() => {
              setTouched(true);
              if (!reasonError) {
                setProblem(null);
                reject.mutate();
              }
            }}
          >
            {problem ? "Try again" : "Reject project"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <ul className="list-disc space-y-1.5 pl-5 text-muted">
          <li><strong className="font-semibold text-text">This cannot be undone.</strong></li>
          <li>This project will never be allocated to you again.</li>
          <li>A different eligible project will be found for you automatically.</li>
          <li>If you've already started work, talk to your supervisor first.</li>
        </ul>
        <FormField
          label="Why are you rejecting this project?"
          htmlFor="reject-reason"
          required
          error={touched ? reasonError ?? undefined : undefined}
          hint={`${reason.trim().length} / ${REJECT_MAX} characters (at least ${REJECT_MIN})`}
        >
          <Textarea
            id="reject-reason"
            rows={4}
            maxLength={REJECT_MAX + 50}
            value={reason}
            aria-invalid={(touched && !!reasonError) || undefined}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
          />
        </FormField>
        {problem && <Alert variant="danger" icon={<WarningCircle />}>{problem}</Alert>}
      </div>
    </Dialog>
  );
}

function RejectionHistory({ entries, loading, error, onRetry }: {
  entries: HistoryEntry[]; loading: boolean; error: unknown; onRetry: () => void;
}) {
  return (
    <Card title="Projects you rejected" icon={<ClockCounterClockwise />}>
      {loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : !entries.length ? (
        <p className="text-sm text-muted">You haven't rejected any project.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {entries.map((h) => (
            <li key={h.allocation.id} className="rounded-lg border border-border p-3 text-sm">
              <p className="text-xs font-semibold tracking-wide text-muted">{h.allocation.project.project_code}</p>
              <p className="font-semibold text-text [overflow-wrap:anywhere]">{h.allocation.project.title}</p>
              <p className="mt-1 text-xs text-muted">
                You rejected this project{h.rejected_at && <> on <DateTime value={h.rejected_at} /></>}.
              </p>
              {h.rejection_reason && (
                <p className="mt-2 rounded-md bg-surface-2 px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap text-muted [overflow-wrap:anywhere]">
                  {h.rejection_reason}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
