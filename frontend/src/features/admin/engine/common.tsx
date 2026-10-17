import { CalendarPlus, CheckCircle, Sparkle, XCircle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import type { Cycle, Recommendation } from "@/api/types";
import { EmptyState, ErrorState, LoadingState, PageHeader, ScoreBar, StatusBadge } from "@/components/shared";
import { cx } from "@/components/ui";
import { useCurrentCycle } from "@/app/AppShell";
import { formatScore } from "@/lib/format";

/** Resolves the active cycle and renders loading / error / "Create a cycle first" before the page body. */
export function WithCycle({ title, description, children }: {
  title: string; description?: ReactNode; children: (cycle: Cycle) => ReactNode;
}) {
  const cycle = useCurrentCycle();
  if (cycle.isLoading) return <><PageHeader title={title} description={description} /><LoadingState /></>;
  if (cycle.error) return <><PageHeader title={title} description={description} /><ErrorState error={cycle.error} onRetry={() => void cycle.refetch()} /></>;
  const c = cycle.data?.data;
  if (!c) {
    return (
      <>
        <PageHeader title={title} description={description} />
        <EmptyState icon={<CalendarPlus />} title="Create a cycle first" description="All planning happens inside the active cycle."
          action={<Link className="font-semibold text-primary hover:underline" to="/admin/cycles">Go to cycles</Link>} />
      </>
    );
  }
  return <>{children(c)}</>;
}

/** Small "disabled with reason" note shown next to a disabled action. */
export function Reason({ children, id }: { children?: ReactNode; id?: string }) {
  if (!children) return null;
  return <p id={id} className="text-xs text-muted">{children}</p>;
}

/** "Cycle <name> <status>" line used in page headers. */
export function CycleLine({ cycle, children }: { cycle: Cycle; children?: ReactNode }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>Cycle <span className="font-medium text-text">{cycle.name}</span></span>
      <StatusBadge kind="cycle" value={cycle.status} />
      {children}
    </span>
  );
}

/** Compact label/value tile for run summaries. */
export function MiniStat({ label, value, hint, tone }: {
  label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "accent" | "warning" | "success";
}) {
  return (
    <div className={cx(
      "rounded-lg border px-3 py-2.5",
      tone === "accent" ? "border-accent/25 bg-accent-soft" : tone === "warning" ? "border-warning/25 bg-warning-bg"
        : tone === "success" ? "border-success/20 bg-success-bg" : "border-border bg-surface-2",
    )}>
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-0.5 font-heading text-lg font-semibold text-text tabular-nums">{value}</dd>
      {hint && <dd className="text-xs text-muted">{hint}</dd>}
    </div>
  );
}

/** AI explanation in the accent ("AI moment") style. */
export function AiExplanation({ text }: { text: string }) {
  return (
    <div className="flex gap-2.5 rounded-lg border border-accent/20 bg-accent-soft px-3 py-2.5 text-sm text-accent-ink">
      <Sparkle aria-hidden size={18} weight="fill" className="mt-0.5 shrink-0 text-accent" />
      <p className="min-w-0 leading-relaxed [overflow-wrap:anywhere]">
        <span className="font-semibold">AI explanation: </span>{text}
      </p>
    </div>
  );
}

const FACTOR_SERIES = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];
const FACTOR_TEXT = ["text-chart-1", "text-chart-2", "text-chart-3", "text-chart-4", "text-chart-5"];

type Factor = Recommendation["factors"][number];

/** Gate factor key → the ineligibility reason that means the gate failed. */
const GATE_REASON: Record<string, string | undefined> = { trade_match: "trade_mismatch" };

/**
 * Itemised factor breakdown: a segmented bar of the points (decorative) plus a list that carries every number.
 * Gate factors (max 0) are shown as pass/fail when the eligibility reasons are known. The total line is the sum of the factor points (= the match score).
 */
export function FactorBreakdown({ factors, ineligibleReasons }: { factors: Factor[]; ineligibleReasons?: string[] }) {
  const scored = factors.filter((f) => f.max_points > 0);
  const gates = factors.filter((f) => f.max_points === 0);
  const total = factors.reduce((s, f) => s + f.points, 0);
  const maxTotal = scored.reduce((s, f) => s + f.max_points, 0);
  return (
    <div className="flex flex-col gap-3">
      <div aria-hidden className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-neutral-bg">
        {scored.map((f, i) => f.points > 0 ? (
          <div key={f.key} className={cx("h-full", FACTOR_SERIES[i % FACTOR_SERIES.length])}
            style={{ width: `${maxTotal ? (f.points / maxTotal) * 100 : 0}%` }} />
        ) : null)}
      </div>
      <ul className="flex flex-col divide-y divide-border">
        {gates.map((f) => {
          const failed = ineligibleReasons ? GATE_REASON[f.key] != null && ineligibleReasons.includes(GATE_REASON[f.key]!) : null;
          return (
            <li key={f.key} className="py-2 text-sm first:pt-0">
              <div className="flex items-baseline justify-between gap-4">
                <span className="flex min-w-0 items-center gap-2 font-medium text-text">
                  {failed === true ? <XCircle aria-hidden size={14} weight="fill" className="shrink-0 text-danger" />
                    : failed === false ? <CheckCircle aria-hidden size={14} weight="fill" className="shrink-0 text-success" />
                      : <span aria-hidden className="size-2.5 shrink-0 rounded-sm border border-border-strong" />}
                  <span className="min-w-0">{f.label}</span>
                  {f.ai_refined && <AiChip />}
                </span>
                <span className="shrink-0 text-xs font-semibold tracking-wide text-muted uppercase">
                  {failed === true ? "Gate · failed" : failed === false ? "Gate · passed" : "Gate"}
                </span>
              </div>
              <p className="mt-1 ml-[18px] text-xs text-muted">{f.detail}</p>
            </li>
          );
        })}
        {scored.map((f, i) => {
          const pct = f.max_points ? Math.max(0, Math.min(100, (f.points / f.max_points) * 100)) : 0;
          return (
            <li key={f.key} className="py-2 text-sm first:pt-0">
              <div className="flex items-baseline justify-between gap-4">
                <span className="flex min-w-0 items-center gap-2 font-medium text-text">
                  <span aria-hidden className={cx("size-2.5 shrink-0 rounded-sm", FACTOR_SERIES[i % FACTOR_SERIES.length])} />
                  <span className="min-w-0">{f.label}</span>
                  {f.ai_refined && <AiChip />}
                </span>
                <span className="shrink-0 tabular-nums">
                  <span className={cx("font-semibold", FACTOR_TEXT[i % FACTOR_TEXT.length])}>{formatScore(f.points, 2)}</span>
                  <span className="text-muted"> / {f.max_points}</span>
                </span>
              </div>
              <div aria-hidden className="mt-1.5 ml-[18px] h-1 overflow-hidden rounded-full bg-neutral-bg">
                <div className={cx("h-full rounded-full", FACTOR_SERIES[i % FACTOR_SERIES.length])} style={{ width: `${pct}%` }} />
              </div>
              <p className="mt-1 ml-[18px] text-xs text-muted">{f.detail}</p>
            </li>
          );
        })}
      </ul>
      <p className="flex items-baseline justify-between gap-4 border-t border-border pt-2 text-sm">
        <span className="font-semibold text-text">Total (sum of factor points)</span>
        <span className="font-semibold tabular-nums">{formatScore(total, 2)}<span className="font-normal text-muted"> / {maxTotal}</span></span>
      </p>
    </div>
  );
}

const SHORT_LABEL: Record<string, string> = {
  practical_readiness: "Practical",
  skill_coverage: "Skills",
  interest_alignment: "Interest",
  theory_safety_readiness: "Theory & safety",
};

/** Always-visible one-line factor summary (points per factor); the full breakdown sits behind a disclosure. */
export function FactorChips({ factors }: { factors: Factor[] }) {
  const scored = factors.filter((f) => f.max_points > 0);
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted" aria-label="Factor points">
      {scored.map((f, i) => (
        <li key={f.key} className="inline-flex items-center gap-1.5">
          <span aria-hidden className={cx("size-2 shrink-0 rounded-sm", FACTOR_SERIES[i % FACTOR_SERIES.length])} />
          <span title={f.label}>{SHORT_LABEL[f.key] ?? f.label}</span>
          <span className="font-semibold text-text tabular-nums">{formatScore(f.points, 1)}<span className="font-normal text-muted">/{f.max_points}</span></span>
        </li>
      ))}
    </ul>
  );
}

function AiChip() {
  return (
    <span title="Refined with AI" className="inline-flex shrink-0 items-center gap-0.5 rounded bg-accent-soft px-1.5 py-px text-[10px] font-semibold text-accent-ink">
      <Sparkle aria-hidden size={10} weight="fill" />AI<span className="sr-only"> refined</span>
    </span>
  );
}

/** One ranked recommendation: rank, who/what, score bar, badges, AI explanation and the factor drill-down. */
export function RecommendationItem({ recommendation: r, perspective, actions, highlight }: {
  recommendation: Recommendation; perspective: "trainee" | "project"; actions?: ReactNode; highlight?: boolean;
}) {
  const title = perspective === "project" ? r.trainee.full_name : r.project.title;
  const code = perspective === "project" ? r.trainee.trainee_code : r.project.project_code;
  return (
    <article className={cx(
      "rounded-lg border bg-surface p-4 transition-colors duration-150",
      highlight ? "border-primary ring-3 ring-primary/15" : r.eligible ? "border-border" : "border-dashed border-border-strong bg-surface-2",
    )}>
      <div className="flex flex-wrap items-start gap-3">
        <span className={cx(
          "inline-flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-bold tabular-nums",
          r.rank === 1 && r.eligible ? "bg-primary text-primary-fg" : "bg-neutral-bg text-neutral",
        )}>
          <span className="sr-only">Rank </span>{r.rank}
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-text [overflow-wrap:anywhere]">{title}</h4>
          <p className="text-xs text-muted">{code}</p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {r.eligible ? <StatusBadge kind="eligibility" value="eligible" />
              : r.ineligible_reasons.map((x) => <StatusBadge key={x} kind="eligibility" value={x} />)}
            <StatusBadge kind="source" value={r.source} />
          </div>
          <div className="mt-2.5"><FactorChips factors={r.factors} /></div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <ScoreBar value={Math.round(r.score * 10) / 10} tone="auto" label="Match score" />
          {actions}
        </div>
      </div>
      {r.ai_explanation && <div className="mt-3"><AiExplanation text={r.ai_explanation} /></div>}
      <details className="mt-3 text-sm">
        <summary className="cursor-pointer font-medium text-primary select-none hover:underline">Why this score?</summary>
        <div className="mt-3 rounded-lg border border-border bg-surface p-3"><FactorBreakdown factors={r.factors} ineligibleReasons={r.ineligible_reasons} /></div>
      </details>
    </article>
  );
}
