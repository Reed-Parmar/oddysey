/** Trainee details drawer for /admin/tracking: profile, allocation history (admin-only replacement data) and every submission version. */
import { CaretRight, ClockCounterClockwise, Files, Info } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { HistoryEntry, ProgressRow, Submission } from "@/api/types";
import { DateTime, EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/shared";
import { Alert, Card, Dialog } from "@/components/ui";
import { MatchExplanation, ReportScore, TraineeProfileView } from "@/features/shared/views";
import { formatScore } from "@/lib/format";
import { label } from "@/lib/statusLabels";

import { formatIst } from "../data/common";

type Replacement = {
  ranking_mode?: string; ranking_note?: string; candidate_count?: number; eligible_count?: number; selected_rank?: number;
  explanation?: string; reason?: string; attempts?: number; updated_at?: string | null;
  replacement_trainee?: { id: string; trainee_code: string; full_name: string } | null;
};

export function TraineeDrawer({ row, onClose }: { row: ProgressRow | null; onClose: () => void }) {
  return (
    <Dialog open={!!row} onClose={onClose} size="lg" title={row ? row.trainee.full_name : "Trainee"}
      description={row ? `${row.trainee.trainee_code} · ${row.trainee.trades.map((t) => t.name).join(", ")}` : undefined}>
      {row && <DrawerBody row={row} />}
    </Dialog>
  );
}

function DrawerBody({ row }: { row: ProgressRow }) {
  const id = row.trainee.id;
  const trainee = useQuery({
    queryKey: qk.trainees.detail(id),
    queryFn: () => call(api.GET("/api/v1/trainees/{trainee_id}", { params: { path: { trainee_id: id } } })),
  });
  const history = useQuery({
    queryKey: qk.allocationHistory.trainee(id),
    queryFn: () => call(api.GET("/api/v1/admin/trainees/{trainee_id}/allocation-history", { params: { path: { trainee_id: id } } })),
  });
  const subsParams = { cycle_id: row.cycle.id, trainee_id: id, latest_only: false, sort: "-submitted_at", page_size: 100 };
  const subs = useQuery({
    queryKey: qk.submissions.list(subsParams),
    queryFn: () => call(api.GET("/api/v1/submissions", { params: { query: subsParams } })),
  });
  const entries = history.data?.data ?? [];
  const versions = subs.data?.data ?? [];
  return (
    <div className="flex flex-col gap-5">
      {trainee.isLoading ? <LoadingState /> : trainee.error ? <ErrorState error={trainee.error} onRetry={() => void trainee.refetch()} /> : trainee.data ? (
        <TraineeProfileView trainee={trainee.data.data} showSensitive />
      ) : null}
      <Card title="Allocation history" icon={<ClockCounterClockwise />} description="Every allocation is kept, including rejected ones. Replacement details are internal to the programme team.">
        {history.isLoading ? <LoadingState /> : history.error ? <ErrorState error={history.error} onRetry={() => void history.refetch()} /> : !entries.length ? (
          <EmptyState title="No allocations yet" description={row.waiting_reason ? `Waiting: ${label("waiting", row.waiting_reason)[0]}.` : "Automatic allocation has not assigned a project yet."} />
        ) : (
          <ol className="flex flex-col gap-4">
            {entries.map((e) => <HistoryItem key={e.allocation.id} entry={e} />)}
          </ol>
        )}
      </Card>
      <Card title="Submissions" icon={<Files />} description="Every version the trainee has submitted, newest first. Open one for the full analysis and review.">
        {subs.isLoading ? <LoadingState /> : subs.error ? <ErrorState error={subs.error} onRetry={() => void subs.refetch()} /> : !versions.length ? (
          <EmptyState title="No submissions yet" description={row.project ? "The trainee has not submitted a report for this project." : "Submissions appear once a project is allocated and the trainee submits."} />
        ) : (
          <ul className="flex flex-col gap-2">
            {versions.map((s, i) => <SubmissionItem key={s.id} s={s} latest={i === 0} />)}
          </ul>
        )}
      </Card>
    </div>
  );
}

function SubmissionItem({ s, latest }: { s: Submission; latest: boolean }) {
  return (
    <li>
      <Link to={`/admin/submissions/${s.id}`}
        className="group flex flex-wrap items-start justify-between gap-x-4 gap-y-2 rounded-xl border border-border p-3 hover:border-border-strong hover:bg-surface-2">
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-x-2 text-sm font-semibold text-text group-hover:text-primary">
            Version {s.version}
            {latest && <span className="rounded-full bg-primary px-1.5 py-px text-[0.62rem] font-semibold tracking-wide text-primary-fg uppercase">Latest</span>}
          </span>
          <span className="block text-xs text-muted">{s.project.project_code} · submitted <DateTime value={s.submitted_at} /></span>
          <span className="mt-1.5 flex flex-wrap gap-1.5">
            <StatusBadge kind="submission" value={s.status} />
            <StatusBadge kind="analysis" value={s.analysis_status} />
            {s.is_late && <StatusBadge kind="late" value="late" />}
          </span>
        </span>
        <span className="flex items-center gap-3 text-sm">
          <span className="flex flex-col items-end gap-0.5">
            <span className="flex flex-wrap items-center justify-end gap-1.5"><span className="text-xs text-muted">Report</span><ReportScore summary={s.report_evaluation} /></span>
            {s.evaluation?.total_score != null && (
              <span className="flex flex-wrap items-center justify-end gap-1.5">
                <span className="text-xs text-muted">Verified</span>
                <span className="font-semibold tabular-nums">{formatScore(s.evaluation.total_score)} / 100</span>
                {s.evaluation.grade && <StatusBadge kind="grade" value={s.evaluation.grade} />}
              </span>
            )}
          </span>
          <CaretRight aria-hidden size={14} className="shrink-0 text-subtle group-hover:text-primary" />
        </span>
      </Link>
    </li>
  );
}

function HistoryItem({ entry: e }: { entry: HistoryEntry }) {
  const a = e.allocation;
  const r = (e.replacement ?? null) as Replacement | null;
  return (
    <li className="rounded-xl border border-border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Link className="font-semibold text-text hover:text-primary hover:underline" to={`/admin/projects/${a.project.id}`}>{a.project.title}</Link>
          <p className="text-xs text-muted">{a.project.project_code} · allocated {formatIst(a.created_at)}{a.project.supervisor ? ` · supervisor ${a.project.supervisor.full_name}` : ""}</p>
        </div>
        <span className="flex flex-wrap gap-1.5">
          <StatusBadge kind="allocationStatus" value={a.status} />
          {e.replacement_status && <StatusBadge kind="replacement" value={e.replacement_status} />}
        </span>
      </div>
      {e.rejection_reason && (
        <div className="mt-3 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm">
          <p className="text-xs font-semibold text-muted uppercase">Rejected by the trainee{e.rejected_at ? ` · ${formatIst(e.rejected_at)}` : ""}</p>
          <p className="mt-1 whitespace-pre-wrap">{e.rejection_reason}</p>
        </div>
      )}
      {r && (
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <Alert variant="info" icon={<Info />} title="Replacement (internal)">
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
              {r.ranking_mode && <><dt className="font-medium">Ranking mode</dt><dd>{label("matchMode", r.ranking_mode)[0]}</dd></>}
              {r.ranking_note && <><dt className="font-medium">Why this mode</dt><dd>{r.ranking_note}</dd></>}
              {r.candidate_count != null && <><dt className="font-medium">Candidates</dt><dd>{r.eligible_count ?? 0} eligible of {r.candidate_count} waiting trainees</dd></>}
              {r.selected_rank != null && <><dt className="font-medium">Selected rank</dt><dd>{r.selected_rank}</dd></>}
              {r.replacement_trainee && <><dt className="font-medium">Replacement trainee</dt><dd>{r.replacement_trainee.full_name} ({r.replacement_trainee.trainee_code})</dd></>}
              {r.explanation && <><dt className="font-medium">Explanation</dt><dd>{r.explanation}</dd></>}
              {r.reason && <><dt className="font-medium">Status note</dt><dd>{r.reason}</dd></>}
              {r.attempts != null && <><dt className="font-medium">Attempts</dt><dd>{r.attempts}{r.updated_at ? ` · last ${formatIst(r.updated_at)}` : ""}</dd></>}
            </dl>
          </Alert>
        </div>
      )}
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer font-medium text-primary select-none hover:underline">Why this project was allocated</summary>
        <div className="mt-3"><MatchExplanation allocation={a} /></div>
      </details>
    </li>
  );
}
