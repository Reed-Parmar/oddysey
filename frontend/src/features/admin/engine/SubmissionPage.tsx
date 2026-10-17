import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { Avatar, BackLink, ErrorState, LoadingState, PageHeader } from "@/components/shared";
import { SubmissionDetailView } from "@/features/shared/views";

/** SUB-03 detail with version history (SUB-02). Read-only: admins cannot evaluate (admin.md §3.8). */
export function AdminSubmissionPage() {
  const { submissionId = "" } = useParams();
  const sub = useQuery({
    queryKey: qk.submissions.detail(submissionId),
    queryFn: () => call(api.GET("/api/v1/submissions/{submission_id}", { params: { path: { submission_id: submissionId } } })),
    enabled: !!submissionId,
  });
  const s = sub.data?.data;
  const historyParams = s ? { cycle_id: s.cycle_id, trainee_id: s.trainee.id, latest_only: false, sort: "submitted_at", page_size: 100 } : undefined;
  const history = useQuery({
    queryKey: qk.submissions.list(historyParams),
    queryFn: () => call(api.GET("/api/v1/submissions", { params: { query: historyParams } })),
    enabled: !!historyParams,
  });

  return (
    <>
      <PageHeader title="Submission" eyebrow={<BackLink to="/admin/progress">Back to progress</BackLink>}
        description={s ? (
          <span className="inline-flex items-center gap-2">
            <Avatar name={s.trainee.full_name} size="sm" />
            <Link className="font-medium text-primary hover:underline" to={`/admin/trainees/${s.trainee.id}`}>{s.trainee.full_name}</Link>
            <span>· {s.trainee.trainee_code}</span>
          </span>
        ) : undefined} />
      {sub.isLoading ? <LoadingState /> : sub.error ? <ErrorState error={sub.error} onRetry={() => void sub.refetch()} /> : s ? (
        <>
          <SubmissionDetailView submission={s} history={history.data?.data} historyHref={(x) => `/admin/submissions/${x.id}`} />
          {history.error != null && <div className="mt-4"><ErrorState error={history.error} onRetry={() => void history.refetch()} /></div>}
        </>
      ) : null}
    </>
  );
}
