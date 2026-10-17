import {
  CalendarBlank, ChartLineUp, ClipboardText, Compass, Exam, FileText, Lightbulb, Medal, UploadSimple, UserCircle,
} from "@phosphor-icons/react";

import {
  DateTime, EmptyState, ErrorState, LoadingState, PageHeader, StatCard, StatusBadge, Steps,
} from "@/components/shared";
import { Alert, Card } from "@/components/ui";
import { ProgressTable } from "@/features/shared/views";
import { formatScore } from "@/lib/format";

import { AllocationPanel, NoAllocationPanel } from "./AllocationPanel";
import { nextStep } from "./forms";
import { useMyProgress, useMyRecommendations, useMyResume, useMySubmissionHistory, useStudentContext } from "./hooks";
import { Fact, LinkButton, StudentRecommendationCard, TextLink } from "./ui";

const DAY_MS = 86_400_000;

function daysLeftLabel(deadline: string): { value: string; tone: "primary" | "warning" | "danger" } {
  const days = Math.ceil((new Date(deadline).getTime() - Date.now()) / DAY_MS);
  if (days < 0) return { value: "Passed", tone: "danger" };
  if (days === 0) return { value: "Today", tone: "warning" };
  return { value: `${days} day${days === 1 ? "" : "s"}`, tone: days <= 3 ? "warning" : "primary" };
}

export function DashboardPage() {
  const { cycle, me } = useStudentContext();
  const allocated = !!me?.allocation;
  const recs = useMyRecommendations();
  const progress = useMyProgress(allocated);
  const history = useMySubmissionHistory(allocated);
  const resume = useMyResume();

  if (!cycle || !me) return <LoadingState />;
  const row = progress.data?.data[0];
  const step = nextStep(cycle, me, row);
  const latest = history.data?.data[0];
  const topRec = recs.data?.data[0];
  const versionCount = history.data?.data.length ?? 0;

  // Journey (presentation only): derived from data this page already loads.
  const status = row?.progress ?? latest?.status;
  const profileDone = me.skills.length > 0 || !!me.career_interest;
  const suggestionsDone = !!topRec || allocated;
  const submittedDone = !!latest || status === "submitted" || status === "rework_requested" || status === "evaluated";
  const evaluatedDone = status === "evaluated";
  const doneFlags = [profileDone, suggestionsDone, allocated, submittedDone, evaluatedDone];
  const firstOpen = doneFlags.findIndex((d) => !d);
  const stateAt = (i: number) => (doneFlags[i] ? "done" : i === firstOpen ? "current" : "todo") as "done" | "current" | "todo";
  const journey = [
    { label: "Profile", hint: profileDone ? "Skills added" : "Add your skills" },
    { label: "Suggestions", hint: topRec ? `${recs.data?.data.length ?? 0} matches ready` : "Shared by the programme team" },
    { label: "Allocated", hint: me.allocation ? me.allocation.project.project_code : "Decided by the programme team" },
    { label: "Submitted", hint: status === "rework_requested" ? "Rework requested" : latest ? `Version ${latest.version}` : "Upload your work" },
    { label: "Evaluated", hint: evaluatedDone && row?.evaluation?.grade ? `Grade ${row.evaluation.grade}` : "Rubric-graded by your supervisor" },
  ].map((s, i) => ({ ...s, state: stateAt(i) }));

  const deadline = daysLeftLabel(cycle.submission_deadline);
  const grade = row?.evaluation?.grade ?? latest?.evaluation?.grade ?? null;
  const matchScore = me.allocation?.match_score ?? topRec?.score ?? null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={cycle.name}
        title={`Welcome, ${me.full_name}`}
        description="Your project journey in this programme cycle at a glance."
      />

      <section className="rounded-xl border border-primary/30 bg-primary-soft p-5 shadow-card" aria-labelledby="next-step-title">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span aria-hidden className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-fg">
              <Compass size={20} />
            </span>
            <div className="min-w-0">
              <h2 id="next-step-title" className="text-xs font-semibold tracking-wide text-primary-ink uppercase">Next step</h2>
              <p className="mt-0.5 font-heading text-lg font-semibold text-text">{step.text}</p>
              {allocated && progress.isLoading && <p className="mt-1 text-xs text-muted">Checking your progress…</p>}
            </div>
          </div>
          {step.to && step.cta && (
            <LinkButton to={step.to} size="md" trailing className="w-full sm:w-auto">
              {step.cta}
            </LinkButton>
          )}
        </div>
      </section>

      <Card title="Your journey" icon={<ChartLineUp />}>
        <Steps steps={journey} />
      </Card>

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <StatCard
          label="Deadline"
          value={deadline.value}
          hint={<DateTime value={cycle.submission_deadline} dateOnly />}
          icon={<CalendarBlank />}
          tone={deadline.tone}
        />
        <StatCard
          label={me.allocation ? "Match score" : "Top match"}
          value={matchScore != null ? formatScore(matchScore) : "—"}
          hint={me.allocation ? "For your allocated project" : topRec ? topRec.project.project_code : "No suggestions yet"}
          icon={<Lightbulb />}
          tone="accent"
          to={me.allocation ? undefined : "/student/recommendations"}
        />
        <StatCard
          label="Versions submitted"
          value={allocated ? versionCount : "—"}
          hint={latest ? <StatusBadge kind="submission" value={latest.status} /> : allocated ? "Nothing submitted yet" : "After allocation"}
          icon={<UploadSimple />}
          tone="neutral"
          to={allocated ? "/student/submission" : undefined}
        />
        <StatCard
          label="Grade"
          value={grade ?? "—"}
          hint={grade ? "Final evaluation" : "Not evaluated yet"}
          icon={<Medal />}
          tone={grade ? "success" : "neutral"}
        />
      </div>

      {me.allocation ? <AllocationPanel allocation={me.allocation} cycle={cycle} /> : <NoAllocationPanel cycle={cycle} />}

      {allocated && (
        <Card title="Latest submission" icon={<ClipboardText />} actions={<TextLink to="/student/submission">My project & submission</TextLink>}>
          {history.isLoading ? (
            <LoadingState />
          ) : history.error ? (
            <ErrorState error={history.error} onRetry={() => history.refetch()} />
          ) : !latest ? (
            <p className="text-sm text-muted">You have not submitted yet.</p>
          ) : (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <LinkButton to={`/student/submissions/${latest.id}`} variant="secondary" size="sm">Version {latest.version}</LinkButton>
                <StatusBadge kind="submission" value={latest.status} />
                {latest.is_late && <StatusBadge kind="late" value="late" />}
                {latest.evaluation?.grade && <StatusBadge kind="grade" value={latest.evaluation.grade} />}
                <span className="text-muted">
                  <DateTime value={latest.submitted_at} />
                </span>
              </div>
              {latest.evaluation?.feedback && (
                <Alert variant={latest.status === "rework_requested" ? "warning" : "info"} title="Supervisor feedback" icon={<Exam />}>
                  <span className="whitespace-pre-wrap">{latest.evaluation.feedback}</span>
                </Alert>
              )}
            </div>
          )}
        </Card>
      )}

      {allocated && (
        <Card title="My progress" icon={<ChartLineUp />}>
          <ProgressTable
            rows={progress.data?.data ?? []}
            isLoading={progress.isLoading}
            error={progress.error}
            onRetry={() => progress.refetch()}
            showTraineeColumn={false}
            showSupervisorColumn
            getRowHref={(r) => (r.latest_submission ? `/student/submissions/${r.latest_submission.id}` : null)}
            emptyState={<p className="text-sm text-muted">Not allocated yet.</p>}
          />
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title="Top suggestion" icon={<Lightbulb />} actions={<TextLink to="/student/recommendations">All suggestions</TextLink>}>
          {recs.isLoading ? (
            <LoadingState />
          ) : recs.error ? (
            <ErrorState error={recs.error} onRetry={() => recs.refetch()} />
          ) : topRec ? (
            <StudentRecommendationCard recommendation={topRec} compact />
          ) : me.assessment_status === "pending" ? (
            <EmptyState icon={<Exam />} title="Suggestions are not available yet" description="Your assessment scores have not been entered yet. The programme team will add them." />
          ) : (
            <EmptyState icon={<Lightbulb />} title="No suggestions yet" description="Your programme team has not generated recommendations yet." />
          )}
        </Card>

        <div className="min-w-0 space-y-6">
        <ResumeStatusCard query={resume} />
        <Card title="My record" icon={<UserCircle />} actions={<TextLink to="/student/profile">View profile</TextLink>}>
          <dl className="grid grid-cols-2 gap-4">
            <Fact label="Trainee code">{me.trainee_code}</Fact>
            <Fact label="Trade">{me.trade.name}</Fact>
            <Fact label="Assessment"><StatusBadge kind="assessment" value={me.assessment_status} /></Fact>
            <Fact label="Skills listed"><span className="tabular-nums">{me.skills.length}</span></Fact>
            <Fact label="Cycle status"><StatusBadge kind="cycle" value={cycle.status} /></Fact>
            <Fact label="Deadline"><DateTime value={cycle.submission_deadline} /></Fact>
          </dl>
        </Card>
        </div>
      </div>
    </div>
  );
}

/** Resume status (RES-02): upload prompt, read failure, or how many suggestions are still unused. */
function ResumeStatusCard({ query }: { query: ReturnType<typeof useMyResume> }) {
  const r = query.data?.data;
  const pending = r?.skill_matches.filter((m) => !m.already_on_profile).length ?? 0;
  return (
    <Card title="Resume" icon={<FileText />} actions={r ? <TextLink to="/student/profile">Review</TextLink> : undefined}>
      {query.isLoading ? <LoadingState /> : query.error ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : !r ? (
        <div className="flex flex-col items-start gap-3 text-sm">
          <p className="text-muted">Upload your resume to get skill suggestions that improve your project matches.</p>
          <LinkButton to="/student/profile" size="sm" icon={<UploadSimple />}>Upload resume</LinkButton>
        </div>
      ) : r.status === "failed" ? (
        <p className="text-sm text-muted">Your last upload could not be read. <TextLink to="/student/profile">Upload another file</TextLink></p>
      ) : (
        <dl className="grid grid-cols-2 gap-4">
          <Fact label="Skills found"><span className="tabular-nums">{r.skill_matches.length}</span></Fact>
          <Fact label="Not yet added"><span className="tabular-nums">{pending}</span></Fact>
          <div className="col-span-2"><Fact label="Uploaded"><DateTime value={r.created_at} /></Fact></div>
        </dl>
      )}
    </Card>
  );
}
