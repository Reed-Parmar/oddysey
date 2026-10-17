import { Link } from "react-router-dom";

import { DateTime, EmptyState, ErrorState, KeyValue, LoadingState, PageHeader, StatusBadge } from "@/components/shared";
import { Alert, Card } from "@/components/ui";
import { ProgressTable, RecommendationCard } from "@/features/shared/views";

import { AllocationPanel, NoAllocationPanel } from "./AllocationPanel";
import { nextStep } from "./forms";
import { useMyProgress, useMyRecommendations, useMySubmissionHistory, useStudentContext } from "./hooks";

const linkBtn = "inline-flex min-h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-fg hover:bg-primary/90";

export function DashboardPage() {
  const { cycle, me } = useStudentContext();
  const allocated = !!me?.allocation;
  const recs = useMyRecommendations();
  const progress = useMyProgress(allocated);
  const history = useMySubmissionHistory(allocated);

  if (!cycle || !me) return <LoadingState />;
  const row = progress.data?.data[0];
  const step = nextStep(cycle, me, row);
  const latest = history.data?.data[0];
  const topRec = recs.data?.data[0];

  return (
    <div>
      <PageHeader title={`Welcome, ${me.full_name}`} description="Your project journey in this programme cycle at a glance." />

      <div className="flex flex-col gap-4">
        <Card title="Next step" className="border-primary/40">
          <p className="text-sm">{step.text}</p>
          {step.to && step.cta && (
            <Link to={step.to} className={`${linkBtn} mt-3`}>
              {step.cta}
            </Link>
          )}
          {allocated && progress.isLoading && <p className="mt-2 text-xs text-muted">Checking your progress…</p>}
        </Card>

        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Programme cycle">
            <KeyValue
              items={[
                ["Cycle", cycle.name],
                ["Status", <StatusBadge key="s" kind="cycle" value={cycle.status} />],
                ["Submission deadline", <DateTime key="d" value={cycle.submission_deadline} />],
              ]}
            />
          </Card>

          <Card title="My record" actions={<Link className="text-sm text-primary underline" to="/student/profile">View profile</Link>}>
            <KeyValue
              items={[
                ["Trainee code", me.trainee_code],
                ["Trade", me.trade.name],
                ["Assessment", <StatusBadge key="a" kind="assessment" value={me.assessment_status} />],
                ["Skills listed", String(me.skills.length)],
              ]}
            />
          </Card>
        </div>

        {me.allocation ? <AllocationPanel allocation={me.allocation} cycle={cycle} /> : <NoAllocationPanel cycle={cycle} />}

        {allocated && (
          <Card title="Latest submission" actions={<Link className="text-sm text-primary underline" to="/student/submission">My project & submission</Link>}>
            {history.isLoading ? (
              <LoadingState />
            ) : history.error ? (
              <ErrorState error={history.error} onRetry={() => history.refetch()} />
            ) : !latest ? (
              <p className="text-sm text-muted">You have not submitted yet.</p>
            ) : (
              <div className="flex flex-col gap-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <Link className="font-medium text-primary underline" to={`/student/submissions/${latest.id}`}>Version {latest.version}</Link>
                  <StatusBadge kind="submission" value={latest.status} />
                  {latest.is_late && <StatusBadge kind="late" value="late" />}
                  {latest.evaluation?.grade && <StatusBadge kind="grade" value={latest.evaluation.grade} />}
                  <span className="text-muted">
                    <DateTime value={latest.submitted_at} />
                  </span>
                </div>
                {latest.evaluation?.feedback && (
                  <Alert variant={latest.status === "rework_requested" ? "warning" : "info"} title="Supervisor feedback">
                    <span className="whitespace-pre-wrap">{latest.evaluation.feedback}</span>
                  </Alert>
                )}
              </div>
            )}
          </Card>
        )}

        {allocated && (
          <Card title="My progress">
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

        <Card title="Top suggestion" actions={<Link className="text-sm text-primary underline" to="/student/recommendations">All suggestions</Link>}>
          {recs.isLoading ? (
            <LoadingState />
          ) : recs.error ? (
            <ErrorState error={recs.error} onRetry={() => recs.refetch()} />
          ) : topRec ? (
            <RecommendationCard recommendation={topRec} compact perspective="trainee" />
          ) : me.assessment_status === "pending" ? (
            <EmptyState title="Suggestions are not available yet" description="Your assessment scores have not been entered yet. The programme team will add them." />
          ) : (
            <EmptyState title="No suggestions yet" description="Your programme team has not generated recommendations yet." />
          )}
        </Card>
      </div>
    </div>
  );
}
