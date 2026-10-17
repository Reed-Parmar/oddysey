/**
 * Why a project was allocated: one row per scoring factor (points of max, a bar, the reason), gate checks as chips,
 * and the sum written out so Σ factor points = score is visible. Shared by trainee and staff views.
 */
import { CheckCircle } from "@phosphor-icons/react";

import type { Allocation } from "@/api/types";
import { StatusBadge } from "@/components/shared";
import { cx } from "@/components/ui";
import { formatScore } from "@/lib/format";
import { label } from "@/lib/statusLabels";

const BAR = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

export function MatchReason({ allocation: a, audience = "staff" }: { allocation: Allocation; audience?: "trainee" | "staff" }) {
  const factors = a.factors ?? [];
  const scored = factors.filter((f) => f.max_points > 0);
  const gates = factors.filter((f) => f.max_points === 0);
  const sum = scored.reduce((n, f) => n + f.points, 0);
  const score = a.match_score ?? sum;

  return (
    <div className="flex flex-col gap-4 text-sm">
      {audience === "staff" && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <span className="font-mono text-2xl font-semibold text-text tabular-nums">{formatScore(a.match_score)}</span>
          <span className="text-xs text-muted">match / 100</span>
          <StatusBadge kind="allocationSource" value={a.trigger === "replacement" ? "replacement" : a.source} />
        </div>
      )}
      {audience === "staff" && a.explanation && <p className="leading-relaxed text-muted">{a.explanation}</p>}

      {gates.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Checks passed">
          {gates.map((g) => (
            <li key={g.key} className="inline-flex items-center gap-1.5 rounded-full bg-success-bg px-2.5 py-1 text-xs font-semibold text-success">
              <CheckCircle aria-hidden size={14} weight="fill" />
              {g.detail || g.label}
            </li>
          ))}
        </ul>
      )}

      {scored.length ? (
        <ul className="flex flex-col gap-3.5">
          {scored.map((f, i) => {
            const pct = Math.max(0, Math.min(100, (f.points / f.max_points) * 100));
            return (
              <li key={f.key}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium text-text">{f.label}</span>
                  <span className="shrink-0 font-mono tabular-nums">
                    <span className="font-semibold text-text">{formatScore(f.points, 2)}</span>
                    <span className="text-subtle"> / {f.max_points}</span>
                  </span>
                </div>
                <div aria-hidden className="mt-1.5 h-2 overflow-hidden rounded-full bg-neutral-bg">
                  <div className={cx("h-full rounded-full bg-linear-to-r from-white/25 to-transparent", BAR[i % BAR.length])} style={{ width: `${pct}%` }} />
                </div>
                {f.detail && <p className="mt-1 text-xs leading-relaxed text-muted">{f.detail}</p>}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-muted">Allocated before itemised factors were recorded.</p>
      )}

      {scored.length > 0 && (
        <p className="rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs text-muted tabular-nums [overflow-wrap:anywhere]">
          {scored.map((f) => formatScore(f.points, 2)).join(" + ")} = <span className="font-semibold text-text">{formatScore(score, 2)}</span> / 100
        </p>
      )}

      <p className="text-xs leading-relaxed text-subtle">
        {a.match_mode ? `${label("matchMode", a.match_mode)[0]}. ` : ""}
        {a.min_match_score > 0 ? `Minimum to qualify: ${formatScore(a.min_match_score)}. ` : ""}
        A fit estimate, not a grade.
      </p>
    </div>
  );
}
