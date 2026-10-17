/** /student/submissions (ADR-022): submit the report, follow its evaluation and see every version. Own submissions only. */
import { Archive, Hourglass } from "@phosphor-icons/react";

import type { Allocation } from "@/api/types";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/shared";
import { Alert } from "@/components/ui";
import { AssistantLauncher } from "@/features/shared/Autopilot";
import { SubmissionDetailView } from "@/features/shared/views";

import { submitBlockedReason } from "./forms";
import { useMySubmissionHistory, useProject, useStudentContext } from "./hooks";
import { AnalysisCard, ReworkFeedback, SubmitBlocked, SubmitForm, VersionTimeline } from "./SubmissionPage";
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
      {a && <AssistantLauncher />}
    </div>
  );
}

function SubmissionsBody({ allocation: a }: { allocation: Allocation }) {
  const { cycle, me } = useStudentContext();
  const project = useProject(a.project.id);
  const subs = useMySubmissionHistory();
  if (subs.isLoading) return <LoadingState />;
  if (subs.error) return <ErrorState error={subs.error} onRetry={() => void subs.refetch()} />;

  const versions = (subs.data?.data ?? []).filter((s) => s.allocation_id === a.id);
  const latest = versions[0];
  const deadline = project.data?.data.effective_deadline ?? cycle?.submission_deadline ?? null;
  const late = !!deadline && Date.now() > new Date(deadline).getTime();
  const blocked = submitBlockedReason(cycle, me, latest);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
      <div className="flex min-w-0 flex-col gap-6">
        <p className="text-sm text-muted">
          Project <span className="font-mono text-text">{a.project.project_code}</span> · {a.project.title}
        </p>
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
      </div>
      <div className="flex min-w-0 flex-col gap-6">
        {versions.length > 0 ? (
          <VersionTimeline versions={versions} currentId={latest?.id} />
        ) : (
          <EmptyState icon={<Hourglass />} title="No versions yet" description="Each report you submit appears here as a new version." />
        )}
      </div>
    </div>
  );
}
