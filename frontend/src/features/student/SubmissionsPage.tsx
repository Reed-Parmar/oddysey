/** /student/submissions (ADR-022): submit the report, follow its evaluation and see every version. Own submissions only. */
import { Archive, ClockCounterClockwise, Hourglass } from "@phosphor-icons/react";

import type { Allocation, Submission } from "@/api/types";
import { DateTime, EmptyState, ErrorState, LoadingState, PageHeader, StatusBadge } from "@/components/shared";
import { Alert, Card } from "@/components/ui";
import { ReportScore, SubmissionDetailView } from "@/features/shared/views";

import { submitBlockedReason } from "./forms";
import { useMySubmissionHistory, useProject, useStudentContext } from "./hooks";
import { AnalysisCard, ReworkNotice, SubmitBlocked, SubmitForm } from "./SubmissionPage";
import { LinkButton } from "./ui";

export function SubmissionsPage() {
  const { cycle, me } = useStudentContext();
  if (!cycle || !me) return <LoadingState />;
  const a = me.allocation;
  return (
    <div className="space-y-6">
      <PageHeader title="Submissions" description="Submit your report, follow its evaluation and see every version you have sent." />
      {cycle.status === "archived" && (
        <Alert variant="info" icon={<Archive />} title="This cycle is archived">
          Your submissions and results are kept read-only.
        </Alert>
      )}
      {a ? (
        <SubmissionsBody allocation={a} />
      ) : (
        <EmptyState
          icon={<Hourglass />}
          title="No project allocated yet"
          description="You can submit once a project is allocated to you. Allocation runs automatically, about every 15 minutes."
          action={<LinkButton to="/student/project" variant="secondary" size="sm" trailing>Go to My Project</LinkButton>}
        />
      )}
    </div>
  );
}

function SubmissionsBody({ allocation: a }: { allocation: Allocation }) {
  const subs = useMySubmissionHistory();
  if (subs.isLoading) return <LoadingState />;
  if (subs.error) return <ErrorState error={subs.error} onRetry={() => void subs.refetch()} />;

  const versions = (subs.data?.data ?? []).filter((s) => s.allocation_id === a.id);
  const latest = versions[0];
  return <SubmissionsContent allocation={a} versions={versions} latest={latest} />;
}

function SubmissionsContent({ allocation: a, versions, latest }: { allocation: Allocation; versions: Submission[]; latest: Submission | undefined }) {
  const { cycle, me } = useStudentContext();
  const project = useProject(a.project.id);
  const deadline = project.data?.data.effective_deadline ?? cycle?.submission_deadline ?? null;
  const late = !!deadline && Date.now() > new Date(deadline).getTime();
  const blocked = submitBlockedReason(cycle, me, latest);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <p className="text-sm text-muted">
        Project <span className="font-mono text-text">{a.project.project_code}</span> · {a.project.title}
      </p>
      {latest?.status === "rework_requested" && (
        <ReworkNotice submission={latest} title={`Rework requested on version ${latest.version}`} />
      )}
      {blocked ? <SubmitBlocked reason={blocked} pending={latest?.status === "submitted"} /> : <SubmitForm nextVersion={(latest?.version ?? 0) + 1} late={late} />}
      {versions.length > 0 ? (
        <AllVersions versions={versions} latestId={latest?.id} />
      ) : (
        <EmptyState icon={<Hourglass />} title="No versions yet" description="Each report you submit appears here as a new version." />
      )}
      {latest && (
        <section aria-label={`Latest version ${latest.version}`} className="flex min-w-0 flex-col gap-6">
          <h2 className="font-heading text-lg font-semibold text-text">Latest version (v{latest.version})</h2>
          <SubmissionDetailView submission={latest} />
          <AnalysisCard submissionId={latest.id} />
        </section>
      )}
    </div>
  );
}

/** Every version of this allocation (newest first), each with its status, analysis, score and a link to its own page. */
function AllVersions({ versions, latestId }: { versions: Submission[]; latestId?: string }) {
  return (
    <Card
      title="All versions"
      icon={<ClockCounterClockwise />}
      description={`${versions.length} version${versions.length === 1 ? "" : "s"} submitted. Open any version to see its evaluation and analysis.`}
      flush
    >
      <ol className="divide-y divide-border border-t border-border">
        {versions.map((v) => (
          <li key={v.id} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-text">
                Version {v.version}
                {v.id === latestId && <span className="rounded-md bg-primary-soft px-1.5 py-0.5 text-xs font-medium text-primary">Latest</span>}
                <span className="text-xs font-normal text-muted"><DateTime value={v.submitted_at} /></span>
              </p>
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <StatusBadge kind="submission" value={v.status} />
                <StatusBadge kind="analysis" value={v.analysis_status} />
                {v.is_late && <StatusBadge kind="late" value="late" />}
                {v.evaluation?.grade && <StatusBadge kind="grade" value={v.evaluation.grade} />}
              </div>
              <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                <span className="text-muted">Report score:</span>
                <ReportScore summary={v.report_evaluation} />
              </p>
            </div>
            <LinkButton to={`/student/submissions/${v.id}`} variant="secondary" size="sm" trailing className="shrink-0 self-start sm:self-center">
              View version {v.version}
            </LinkButton>
          </li>
        ))}
      </ol>
    </Card>
  );
}
