import { Link } from "react-router-dom";

import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/shared";
import { Alert } from "@/components/ui";
import { RecommendationCard } from "@/features/shared/views";

import { useMyRecommendations, useStudentContext } from "./hooks";

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
        title="Suggestions are not available yet"
        description="Your assessment scores have not been entered yet, so suggestions are not available. The programme team will add them."
        action={<Link className="text-primary underline" to="/student/profile">Review my profile</Link>}
      />
    ) : (
      <EmptyState
        title="No suggestions yet"
        description="Your programme team has not generated recommendations. They appear after the programme team runs them."
        action={<Link className="text-primary underline" to="/student/projects">Browse the project catalogue</Link>}
      />
    );
  else
    body = (
      <ol className="flex flex-col gap-3">
        {recs.data.data.map((r) => (
          <li key={r.id}>
            <RecommendationCard
              recommendation={r}
              perspective="trainee"
              actions={<Link className="text-sm text-primary underline" to={`/student/projects/${r.project.id}`}>View project</Link>}
            />
          </li>
        ))}
      </ol>
    );

  return (
    <div>
      <PageHeader title="Suggested projects" description="Your top matches from the latest recommendation run, with the factors behind each score." />
      <div className="flex flex-col gap-4">
        <Alert variant="info">These are suggestions. Final allocation is decided by the programme team.</Alert>
        {me?.allocation && (
          <Alert variant="success" title="Allocations are published">
            You have been allocated to {me.allocation.project.project_code} {me.allocation.project.title}.{" "}
            <Link className="underline" to="/student/submission">Go to My project</Link>
          </Alert>
        )}
        {body}
      </div>
    </div>
  );
}
