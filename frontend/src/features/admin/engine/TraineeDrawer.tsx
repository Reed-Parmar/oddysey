/** Trainee details drawer for /admin/tracking: profile, allocation history (admin-only replacement data), resume, latest submission. */
import { ArrowRight, ClockCounterClockwise, Info } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { HistoryEntry, ProgressRow } from "@/api/types";
import { EmptyState, ErrorState, LoadingState, StatusBadge } from "@/components/shared";
import { Alert, Card, Dialog } from "@/components/ui";
import { MatchExplanation, TraineeProfileView, TraineeResumeCard } from "@/features/shared/views";
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
  const entries = history.data?.data ?? [];
  return (
    <div className="flex flex-col gap-5">
      {row.latest_submission && (
        <Link to={`/admin/submissions/${row.latest_submission.id}`}
          className="inline-flex items-center gap-1.5 self-start rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm font-semibold text-primary shadow-card hover:bg-surface-2">
          Open latest submission (version {row.latest_submission.version}) <ArrowRight aria-hidden size={14} />
        </Link>
      )}
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
      <TraineeResumeCard traineeId={id} canDownload />
    </div>
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
