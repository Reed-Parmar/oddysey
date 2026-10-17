import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { DateTime, EmptyState, ErrorState, LoadingState, NotFound, PageHeader, ScoreBar, StatusBadge } from "@/components/shared";
import { Card } from "@/components/ui";
import { FactorTable, TraineeProfileView } from "@/features/shared/views";

export function TraineeProfilePage() {
  const { traineeId = "" } = useParams();
  const trainee = useQuery({
    queryKey: qk.trainees.detail(traineeId),
    queryFn: () => call(api.GET("/api/v1/trainees/{trainee_id}", { params: { path: { trainee_id: traineeId } } })),
  });
  const aq = { trainee_id: traineeId, page_size: 1 };
  const alloc = useQuery({
    queryKey: qk.allocations.list(aq),
    queryFn: () => call(api.GET("/api/v1/allocations", { params: { query: aq } })),
    enabled: trainee.isSuccess,
  });
  const sq = { trainee_id: traineeId, latest_only: false, sort: "-submitted_at", page_size: 100 };
  const subs = useQuery({
    queryKey: qk.submissions.list(sq),
    queryFn: () => call(api.GET("/api/v1/submissions", { params: { query: sq } })),
    enabled: trainee.isSuccess,
  });

  if (trainee.isLoading) return <LoadingState />;
  if (trainee.error) return <ErrorState error={trainee.error} onRetry={() => void trainee.refetch()} />;
  const t = trainee.data?.data;
  if (!t) return <NotFound />;
  const a = alloc.data?.data[0];

  return (
    <>
      <PageHeader title={t.full_name} description={<Link className="text-primary underline" to="/supervisor/progress">Back to progress</Link>} />
      <div className="flex flex-col gap-4">
        <TraineeProfileView trainee={t} showSensitive={false} />

        <Card title="Allocation">
          {alloc.isLoading ? <LoadingState /> : alloc.error ? (
            <ErrorState error={alloc.error} onRetry={() => void alloc.refetch()} />
          ) : !a ? (
            <EmptyState title="No allocation on your projects" />
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Link className="text-primary underline" to={`/supervisor/projects/${a.project.id}`}>{a.project.project_code} · {a.project.title}</Link>
                <span className="flex flex-wrap gap-1">
                  <StatusBadge kind="allocationSource" value={a.source} />
                  {a.is_override && <StatusBadge kind="allocationSource" value="override" />}
                </span>
              </div>
              <div className="text-sm">Match score: {a.match_score == null ? "—" : <ScoreBar value={a.match_score} label="Match score" />}</div>
              {a.factors ? <FactorTable factors={a.factors} /> : <p className="text-sm text-muted">Manual allocation, no recommendation factors.</p>}
            </div>
          )}
        </Card>

        <Card title="Submissions">
          {subs.isLoading ? <LoadingState /> : subs.error ? (
            <ErrorState error={subs.error} onRetry={() => void subs.refetch()} />
          ) : !subs.data?.data.length ? (
            <EmptyState title="No submissions yet" />
          ) : (
            <ul className="divide-y divide-border text-sm">
              {subs.data.data.map((s) => (
                <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <Link className="text-primary underline" to={`/supervisor/submissions/${s.id}`}>Version {s.version}</Link>
                  <span className="flex flex-wrap items-center gap-2">
                    <DateTime value={s.submitted_at} />
                    {s.is_late && <StatusBadge kind="late" value="late" />}
                    <StatusBadge kind="submission" value={s.status} />
                    {s.evaluation?.grade && <StatusBadge kind="grade" value={s.evaluation.grade} />}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
