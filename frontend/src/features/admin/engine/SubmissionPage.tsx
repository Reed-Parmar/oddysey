/** /admin/submissions/:submissionId: submission + version history, originality & automated evaluation, review, retry. */
import { ArrowClockwise, MagnifyingGlass } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { ApiError } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import { Avatar, BackLink, EmptyState, ErrorState, LoadingState, PageHeader, useToast } from "@/components/shared";
import { Button, Card } from "@/components/ui";
import { AnalysisReport, ReviewActions, SubmissionDetailView, useAnalysis } from "@/features/shared/views";

import { ApiErrorAlert, useInvalidate } from "../data/common";

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
    <div className="space-y-6">
      <PageHeader title="Submission" eyebrow={<BackLink to="/admin/tracking">Back to Allocation & Progress</BackLink>}
        description={s ? (
          <span className="inline-flex items-center gap-2">
            <Avatar name={s.trainee.full_name} size="sm" />
            <span className="font-medium text-text">{s.trainee.full_name}</span>
            <span>· {s.trainee.trainee_code}</span>
          </span>
        ) : undefined} />
      {sub.isLoading ? <LoadingState /> : sub.error ? <ErrorState error={sub.error} onRetry={() => void sub.refetch()} /> : s ? (
        <>
          <SubmissionDetailView submission={s} history={history.data?.data} historyHref={(x) => `/admin/submissions/${x.id}`} />
          {history.error != null && <ErrorState error={history.error} onRetry={() => void history.refetch()} />}
          <AnalysisSection submissionId={s.id} />
        </>
      ) : null}
    </div>
  );
}

function AnalysisSection({ submissionId }: { submissionId: string }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const analysis = useAnalysis(submissionId, true);
  const retry = useMutation({
    mutationFn: () => call(api.POST("/api/v1/submissions/{submission_id}/analysis/retry", { params: { path: { submission_id: submissionId } } })),
    onSuccess: () => {
      toast.success("Analysis queued again");
      invalidate(qk.submissions.analysis(submissionId), qk.submissions.detail(submissionId), qk.progress.all());
    },
  });
  const a = analysis.data?.data;
  const notYet = analysis.error instanceof ApiError && analysis.error.status === 404;
  return (
    <>
      <Card title="Plagiarism & Originality Analysis and automated evaluation" icon={<MagnifyingGlass />}
        actions={a?.status === "failed" ? (
          <Button size="sm" variant="secondary" icon={<ArrowClockwise />} loading={retry.isPending} onClick={() => retry.mutate()}>Retry analysis</Button>
        ) : undefined}>
        <div className="flex flex-col gap-3">
          <ApiErrorAlert error={retry.error} />
          {analysis.isLoading ? <LoadingState /> : notYet ? (
            <EmptyState icon={<MagnifyingGlass />} title="Not analysed yet" description="The report is analysed automatically after submission. This page updates when results are ready." />
          ) : analysis.error ? <ErrorState error={analysis.error} onRetry={() => void analysis.refetch()} /> : a ? (
            <AnalysisReport analysis={a} showExport />
          ) : null}
        </div>
      </Card>
      {a && <ReviewActions analysis={a} submissionId={submissionId} />}
    </>
  );
}
