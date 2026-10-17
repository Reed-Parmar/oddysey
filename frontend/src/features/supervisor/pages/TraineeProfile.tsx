import { ArrowRight, ClipboardText, FolderSimple } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import {
  BackLink, DateTime, EmptyState, ErrorState, LoadingState, NotFound, PageHeader, ScoreBar, StatusBadge,
} from "@/components/shared";
import { Card } from "@/components/ui";
import { FactorTable, TraineeProfileView, TraineeResumeCard } from "@/features/shared/views";

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
      <PageHeader
        eyebrow={<BackLink to="/supervisor/progress">Back to progress</BackLink>}
        title={t.full_name}
        description={<span className="tabular-nums">{t.trainee_code} · {t.trade.name}</span>}
      />
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <div className="min-w-0 space-y-6">
          <TraineeProfileView trainee={t} showSensitive={false} />
          <TraineeResumeCard traineeId={t.id} />
        </div>

        <div className="min-w-0 space-y-6">
          <Card icon={<FolderSimple />} title="Allocation">
            {alloc.isLoading ? <LoadingState /> : alloc.error ? (
              <ErrorState error={alloc.error} onRetry={() => void alloc.refetch()} />
            ) : !a ? (
              <EmptyState icon={<FolderSimple />} title="No allocation on your projects" />
            ) : (
              <div className="flex flex-col gap-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <Link className="min-w-0 font-semibold text-primary hover:underline" to={`/supervisor/projects/${a.project.id}`}>
                    <span className="block text-xs font-semibold tracking-wide text-muted uppercase">{a.project.project_code}</span>
                    {a.project.title}
                  </Link>
                  <span className="flex flex-wrap gap-1">
                    <StatusBadge kind="allocationSource" value={a.source} />
                    {a.is_override && <StatusBadge kind="allocationSource" value="override" />}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="text-muted">Match score</span>
                  {a.match_score == null ? <span>—</span> : <ScoreBar value={a.match_score} label="Match score" />}
                </div>
                {a.factors ? <FactorTable factors={a.factors} /> : <p className="text-sm text-muted">Allocated before itemised factors were recorded.</p>}
              </div>
            )}
          </Card>

          <Card icon={<ClipboardText />} title="Submissions" flush>
            {subs.isLoading ? <div className="px-5 pb-5"><LoadingState /></div> : subs.error ? (
              <div className="px-5 pb-5"><ErrorState error={subs.error} onRetry={() => void subs.refetch()} /></div>
            ) : !subs.data?.data.length ? (
              <div className="px-5 pb-5"><EmptyState icon={<ClipboardText />} title="No submissions yet" /></div>
            ) : (
              <ul className="divide-y divide-border border-t border-border text-sm">
                {subs.data.data.map((s) => (
                  <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3">
                    <span className="flex flex-wrap items-center gap-2">
                      <Link className="inline-flex items-center gap-1 font-semibold text-primary hover:underline" to={`/supervisor/submissions/${s.id}`}>
                        Version {s.version} <ArrowRight aria-hidden size={14} />
                      </Link>
                      <span className="text-muted"><DateTime value={s.submitted_at} /></span>
                    </span>
                    <span className="flex flex-wrap items-center gap-1.5">
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
      </div>
    </>
  );
}
