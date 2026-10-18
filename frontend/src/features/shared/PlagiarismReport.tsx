/**
 * ADR-026 detailed Plagiarism & Originality report (SUB-09) with a PDF download (SUB-10).
 * Everything shown comes from the persisted analysis, redacted to the viewer by the server.
 */
import { CheckCircle, DownloadSimple, FileMagnifyingGlass, Info, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { API_BASE, api, authHeaders, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import type { OriginalityReport } from "@/api/types";
import { ErrorState, Skeleton, useToast } from "@/components/shared";
import { Button, cx } from "@/components/ui";

/** Highlight colours per source (cycled), always paired with a [S#] tag so colour is never the only cue. */
const MARK = [
  "bg-warning-bg text-text decoration-warning",
  "bg-danger-bg text-text decoration-danger",
  "bg-violet-soft text-text decoration-violet",
  "bg-accent-soft text-text decoration-accent",
  "bg-primary-soft text-text decoration-primary",
];
const markFor = (n: number) => MARK[(n - 1) % MARK.length];

const DECISION = {
  rework_required: { title: "Rework required", icon: XCircle, tone: "border-danger/40 bg-danger-bg text-danger" },
  review_suggested: { title: "Review suggested", icon: WarningCircle, tone: "border-warning/40 bg-warning-bg text-warning" },
  acceptable: { title: "No significant overlap", icon: CheckCircle, tone: "border-success/40 bg-success-bg text-success" },
  not_enough_text: { title: "Not enough text to assess", icon: Info, tone: "border-border bg-surface-2 text-muted" },
} as const;

export function usePlagiarismReport(submissionId: string, enabled = true) {
  return useQuery({
    queryKey: ["originality-report", submissionId],
    queryFn: () =>
      call(api.GET("/api/v1/submissions/{submission_id}/analysis/originality-report", { params: { path: { submission_id: submissionId } } })),
    enabled,
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
}

function DownloadPdf({ submissionId, version }: { submissionId: string; version: number }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={<DownloadSimple />}
      loading={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const res = await fetch(`${API_BASE}/submissions/${submissionId}/analysis/originality-report.pdf`, { headers: await authHeaders() });
          if (!res.ok) throw new Error(res.status === 404 ? "The report is not ready yet." : `Download failed (${res.status})`);
          const url = URL.createObjectURL(await res.blob());
          const link = document.createElement("a");
          link.href = url;
          link.download = `plagiarism-report-v${version}.pdf`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } catch (e) {
          toast.error(errorMessage(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      Download PDF
    </Button>
  );
}

export function PlagiarismReport({ submissionId }: { submissionId: string }) {
  const q = usePlagiarismReport(submissionId);
  if (q.isLoading) return <Skeleton className="h-40 w-full rounded-xl" />;
  if (q.error) {
    if (q.error instanceof ApiError && q.error.status === 404) return <p className="text-muted">The plagiarism report appears once the analysis finishes.</p>;
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  }
  const r = q.data?.data as OriginalityReport | undefined;
  if (!r) return null;
  const d = DECISION[r.decision as keyof typeof DECISION] ?? DECISION.not_enough_text;
  const pct = r.overlap_pct;
  const lifted = !!(r.decision_record as { lifted_at?: string } | null)?.lifted_at;

  return (
    <div className="flex flex-col gap-5">
      {/* summary */}
      <div className={cx("rounded-xl border p-4", d.tone)}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <d.icon aria-hidden size={28} weight="fill" className="mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-mono text-3xl font-semibold tabular-nums">{pct == null ? "—" : `${pct.toFixed(1)}%`}</span>
                <span className="text-base font-semibold">{d.title}{lifted ? " (lifted by staff)" : ""}</span>
              </p>
              <p className="mt-1 text-sm text-text">{r.decision_text}</p>
            </div>
          </div>
          <DownloadPdf submissionId={submissionId} version={r.version} />
        </div>
        {pct != null && (
          <div className="mt-4">
            <div className="relative h-2.5 overflow-hidden rounded-full bg-surface" role="img" aria-label={`Overlap ${pct.toFixed(1)}% against a rework limit of ${r.rework_threshold}%`}>
              <div className={cx("h-full rounded-full", pct >= r.rework_threshold ? "bg-danger" : pct >= 15 ? "bg-warning" : "bg-success")} style={{ width: `${Math.min(100, pct)}%` }} />
              <div aria-hidden className="absolute inset-y-0 w-0.5 bg-text" style={{ left: `${r.rework_threshold}%` }} />
            </div>
            <p className="mt-1 flex justify-between text-xs text-muted"><span>0%</span><span>Rework at {r.rework_threshold}%</span><span>100%</span></p>
          </div>
        )}
      </div>

      {/* how it was measured */}
      <div className="grid gap-3 text-sm sm:grid-cols-3">
        <Stat label="Words analysed" value={`${r.tokens.eligible ?? 0} / ${r.tokens.total ?? 0}`} />
        <Stat label="Matched sources" value={String(r.sources.length)} />
        <Stat label="Matched passages" value={String(r.passages.length)} />
      </div>
      <p className="text-xs text-muted">
        Method: {r.method}. Overlap is the share of your words that appear in the same 5-word sequences in another submission.
        {r.exclusions.length > 0 && <> Not counted: {r.exclusions.map((e) => `${String(e.label).toLowerCase()} (${String(e.tokens)} words)`).join(", ")}.</>}
      </p>

      {/* sources */}
      {r.sources.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold">Matched sources</h4>
          <ul className="flex flex-wrap gap-2">
            {r.sources.map((s) => (
              <li key={s.number} className={cx("rounded-lg px-2.5 py-1.5 text-xs", markFor(s.number))}>
                <span className="font-mono font-semibold">[S{s.number}]</span> {s.label} · {s.matched_tokens} words
                {s.coverage_pct != null && ` · ${s.coverage_pct}%`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* passages */}
      {r.passages.length > 0 && (
        <details className="group rounded-xl border border-border bg-surface" open={r.passages.length <= 6}>
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold">
            Matched passages and the exact words ({r.passages.length})
          </summary>
          <ol className="space-y-3 border-t border-border px-4 py-3">
            {r.passages.map((p, i) => (
              <li key={i} className="text-sm">
                <p className="mb-1 text-xs text-muted"><span className="font-mono font-semibold">[S{p.source}]</span> · {p.tokens} matched words</p>
                <blockquote className={cx("rounded-md px-3 py-2 underline decoration-2 underline-offset-4", markFor(p.source))}>“{p.words}”</blockquote>
                {p.source_excerpt && <p className="mt-1 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">Source: {p.source_excerpt}</p>}
              </li>
            ))}
          </ol>
        </details>
      )}

      {/* highlighted full text */}
      {r.segments.length > 0 && (
        <div>
          <h4 className="mb-1 flex items-center gap-2 text-sm font-semibold">
            <FileMagnifyingGlass aria-hidden size={16} className="text-primary" /> Your report with matched words highlighted
          </h4>
          <p className="mb-2 text-xs text-muted">Highlighted words matched the source shown after them.</p>
          <div className="max-h-[28rem] overflow-y-auto rounded-xl border border-border bg-surface px-4 py-3 text-sm leading-7 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {r.segments.map((seg, i) =>
              seg.source ? (
                <span key={i}>
                  <mark className={cx("rounded px-0.5 underline decoration-2 underline-offset-4", markFor(seg.source))}>{seg.text}</mark>
                  <sup className="ml-0.5 font-mono text-[0.65rem] font-semibold text-muted">S{seg.source}</sup>
                </span>
              ) : (
                <span key={i}>{seg.text}</span>
              ),
            )}
          </div>
          {r.text_truncated && <p className="mt-1 text-xs text-muted">Only the first part of a long report is shown here; the PDF has the same view.</p>}
        </div>
      )}

      {/* next steps */}
      <div>
        <h4 className="mb-1 text-sm font-semibold">What to do next</h4>
        <ul className="list-disc space-y-0.5 pl-5 text-sm">{r.next_steps.map((s) => <li key={s}>{s}</li>)}</ul>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className="font-mono text-base font-semibold tabular-nums">{value}</p>
    </div>
  );
}
