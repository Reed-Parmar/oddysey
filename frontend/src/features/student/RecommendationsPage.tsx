import { CheckCircle, Exam, Info, Lightbulb, MagnifyingGlass, UserCircle } from "@phosphor-icons/react";
import { Link } from "react-router-dom";

import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/shared";
import { Alert } from "@/components/ui";

import { useMyRecommendations, useStudentContext } from "./hooks";
import { LinkButton, StudentRecommendationCard } from "./ui";

export function RecommendationsPage() {
  const { cycle, me } = useStudentContext();
  const recs = useMyRecommendations();

  let body;
  if (recs.isLoading || !me) body = <LoadingState />;
  else if (recs.error) body = <ErrorState error={recs.error} onRetry={() => recs.refetch()} />;
  else if (!cycle) body = <EmptyState title="No active cycle" />;
  else if (!recs.data?.data.length)
    body = me.assessment_status === "pending" ? (
      <EmptyState
        icon={<Exam />}
        title="Suggestions are not available yet"
        description="Your assessment scores have not been entered yet, so suggestions are not available. The programme team will add them."
        action={<LinkButton to="/student/profile" variant="secondary" icon={<UserCircle />}>Review my profile</LinkButton>}
      />
    ) : (
      <EmptyState
        icon={<Lightbulb />}
        title="No suggestions yet"
        description="Your programme team has not generated recommendations. They appear after the programme team runs them."
        action={<LinkButton to="/student/projects" variant="secondary" icon={<MagnifyingGlass />}>Browse the project catalogue</LinkButton>}
      />
    );
  else
    body = (
      <ol className="flex flex-col gap-4" aria-label="Suggested projects, best match first">
        {recs.data.data.map((r, i) => (
          <li key={r.id}>
            <StudentRecommendationCard
              recommendation={r}
              highlight={i === 0}
              actions={<LinkButton to={`/student/projects/${r.project.id}`} variant="secondary" size="sm" trailing>View project</LinkButton>}
            />
          </li>
        ))}
      </ol>
    );

  return (
    <div className="space-y-6">
      <PageHeader title="Suggested projects" description="Your top matches from the latest recommendation run, with the factors behind each score." />
      <div className="flex flex-col gap-4">
        <Alert variant="info" icon={<Info />}>These are suggestions. Final allocation is decided by the programme team.</Alert>
        {me?.allocation && (
          <Alert variant="success" title="Allocations are published" icon={<CheckCircle />}>
            You have been allocated to {me.allocation.project.project_code} {me.allocation.project.title}.{" "}
            <Link className="font-semibold underline" to="/student/submission">Go to My project</Link>
          </Alert>
        )}
        {body}
      </div>
    </div>
  );
}
