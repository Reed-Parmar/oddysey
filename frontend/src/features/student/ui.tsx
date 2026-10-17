/** Student-module presentational helpers (layout only; no data fetching). Owned by the Student module. */
import { ArrowRight, Info, Sparkle } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import type { Factor, Recommendation } from "@/api/types";
import { ScoreBar, StatusBadge } from "@/components/shared";
import { cx } from "@/components/ui";
import { formatScore } from "@/lib/format";

const LINK_VARIANTS = {
  primary: "bg-primary text-primary-fg shadow-card hover:bg-primary-hover",
  secondary: "border border-border-strong bg-surface text-text shadow-card hover:border-subtle hover:bg-surface-2",
  ghost: "text-primary hover:bg-primary-soft",
};

/** A router link styled like a Button (for navigation actions). */
export function LinkButton({ to, children, variant = "primary", size = "md", icon, trailing, className }: {
  to: string;
  children: ReactNode;
  variant?: keyof typeof LINK_VARIANTS;
  size?: "sm" | "md";
  icon?: ReactNode;
  /** Show a trailing arrow. */
  trailing?: boolean;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg py-1.5 text-center font-semibold transition-colors duration-150",
        size === "sm" ? "min-h-9 px-3 text-sm" : "min-h-10 px-4 text-sm",
        LINK_VARIANTS[variant],
        className,
      )}
    >
      {icon && <span aria-hidden className="inline-flex shrink-0 [&>svg]:size-4">{icon}</span>}
      {children}
      {trailing && <ArrowRight aria-hidden size={16} className="shrink-0" />}
    </Link>
  );
}

/** Small text link with an arrow, for card header actions. */
export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex min-h-9 items-center gap-1 rounded text-sm font-semibold text-primary transition-colors hover:text-primary-ink">
      {children}
      <ArrowRight aria-hidden size={14} />
    </Link>
  );
}

/** Factor-by-factor breakdown. Each row shows its points; the footer shows the total (Σ points = score). */
export function FactorList({ factors, total }: { factors: Factor[]; total?: number | null }) {
  return (
    <div className="mt-3">
      <ul className="divide-y divide-border rounded-lg border border-border">
        {factors.map((f) => {
          const gate = f.max_points === 0;
          const pct = gate || f.max_points <= 0 ? 0 : Math.max(0, Math.min(100, (f.points / f.max_points) * 100));
          return (
            <li key={f.key} className="px-3 py-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <p className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-text">
                  {f.label}
                  {f.ai_refined && (
                    <span className="inline-flex items-center gap-0.5 rounded bg-accent-soft px-1.5 text-[11px] font-semibold text-accent-ink" title="Refined with AI">
                      <Sparkle aria-hidden size={10} weight="fill" />
                      AI
                    </span>
                  )}
                </p>
                <span className="shrink-0 text-sm font-semibold text-text tabular-nums">
                  {gate ? <span className="font-medium text-muted">Requirement</span> : (
                    <>
                      {formatScore(f.points, 2)}
                      <span className="font-normal text-muted"> / {f.max_points}</span>
                    </>
                  )}
                </span>
              </div>
              {!gate && (
                <div aria-hidden className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-neutral-bg">
                  <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                </div>
              )}
              {f.detail && <p className="mt-1.5 text-xs leading-relaxed text-muted">{f.detail}</p>}
            </li>
          );
        })}
        {total != null && (
          <li className="flex items-baseline justify-between gap-3 bg-surface-2 px-3 py-2.5 text-sm">
            <span className="font-semibold text-text">Total match score</span>
            <span className="font-semibold text-text tabular-nums">
              {formatScore(total, 2)}
              <span className="font-normal text-muted"> / 100</span>
            </span>
          </li>
        )}
      </ul>
    </div>
  );
}

/** AI-written summary: visually distinct and clearly labelled as a helper, not a decision. */
export function AiExplanation({ text }: { text: string }) {
  return (
    <div className="mt-3 rounded-lg border border-accent/20 bg-accent-soft px-3.5 py-3">
      <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-accent-ink uppercase">
        <Sparkle aria-hidden size={14} weight="fill" />
        AI summary
      </p>
      <p className="mt-1 text-sm leading-relaxed text-text">{text}</p>
      <p className="mt-1.5 text-xs text-muted">Written by AI from the factors below. The factor points decide the score.</p>
    </div>
  );
}

/** Trainee-facing recommendation card: rank, score, AI summary, factor breakdown. */
export function StudentRecommendationCard({ recommendation: r, actions, compact, highlight }: {
  recommendation: Recommendation;
  actions?: ReactNode;
  /** Collapse the factor breakdown behind a disclosure. */
  compact?: boolean;
  /** Emphasise the card (e.g. the top match). */
  highlight?: boolean;
}) {
  const factors = <FactorList factors={r.factors} total={r.score} />;
  return (
    <article className={cx(
      "rounded-xl border bg-surface p-4 shadow-card sm:p-5",
      highlight ? "border-primary/40 ring-1 ring-primary/10" : "border-border",
    )}>
      <div className="flex items-start gap-3">
        <span
          aria-hidden
          className={cx(
            "inline-flex size-10 shrink-0 items-center justify-center rounded-lg font-heading text-base font-semibold tabular-nums",
            highlight ? "bg-primary text-primary-fg" : "bg-primary-soft text-primary-ink",
          )}
        >
          {r.rank}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted">
            <span className="sr-only">Rank {r.rank} · </span>
            {highlight ? "Top match · " : ""}{r.project.project_code}
          </p>
          <h3 className="text-base font-semibold text-text [overflow-wrap:anywhere]">{r.project.title}</h3>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <ScoreBar value={Math.round(r.score * 10) / 10} label="Match score" tone="auto" />
            <div className="flex flex-wrap gap-1.5">
              {r.eligible
                ? <StatusBadge kind="eligibility" value="eligible" />
                : r.ineligible_reasons.map((x) => <StatusBadge key={x} kind="eligibility" value={x} />)}
              <StatusBadge kind="source" value={r.source} />
            </div>
          </div>
        </div>
      </div>
      {r.ai_explanation && <AiExplanation text={r.ai_explanation} />}
      {compact ? (
        <details className="group mt-3 text-sm">
          <summary className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 font-semibold text-primary">
            <Info aria-hidden size={16} />
            Why this score?
          </summary>
          {factors}
        </details>
      ) : (
        <>
          <h4 className="mt-4 text-xs font-semibold tracking-wide text-muted uppercase">How the score adds up</h4>
          {factors}
        </>
      )}
      {actions && <div className="mt-4 flex flex-wrap gap-2">{actions}</div>}
    </article>
  );
}

/** A labelled read-only value tile. */
export function Fact({ label, children, icon }: { label: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
        {icon && <span aria-hidden className="inline-flex [&>svg]:size-3.5">{icon}</span>}
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium text-text [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
