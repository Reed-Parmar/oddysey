/** Small, accessible charts. Every chart has a text summary and a legend that carries the numbers. */
import { cx } from "@/components/ui";

/** `tone` is a colour token name such as "success" or "chart-2"; it defaults to the series order. */
export type ChartSegment = { label: string; value: number; tone?: string };

const SERIES = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5"];
const toneOf = (s: ChartSegment, i: number) => s.tone ?? SERIES[i % SERIES.length];

// Static class maps so Tailwind generates them.
const STROKE: Record<string, string> = {
  "chart-1": "stroke-chart-1", "chart-2": "stroke-chart-2", "chart-3": "stroke-chart-3", "chart-4": "stroke-chart-4", "chart-5": "stroke-chart-5",
  success: "stroke-success", info: "stroke-info", warning: "stroke-warning", danger: "stroke-danger", subtle: "stroke-subtle",
  primary: "stroke-primary", accent: "stroke-accent", clay: "stroke-clay", violet: "stroke-violet",
};
const FILL: Record<string, string> = {
  "chart-1": "bg-chart-1", "chart-2": "bg-chart-2", "chart-3": "bg-chart-3", "chart-4": "bg-chart-4", "chart-5": "bg-chart-5",
  success: "bg-success", info: "bg-info", warning: "bg-warning", danger: "bg-danger", subtle: "bg-subtle",
  primary: "bg-primary", accent: "bg-accent", clay: "bg-clay", violet: "bg-violet",
};

function Legend({ segments }: { segments: ChartSegment[] }) {
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {segments.map((s, i) => (
        <li key={s.label} className="flex items-center gap-2">
          <span aria-hidden className={cx("size-2.5 shrink-0 rounded-sm", FILL[toneOf(s, i)])} />
          <span className="min-w-0 flex-1 truncate text-muted">{s.label}</span>
          <span className="font-semibold tabular-nums">{s.value}</span>
        </li>
      ))}
    </ul>
  );
}

/** Donut with the total in the middle and a legend beside it. */
export function Donut({ segments, label, centerLabel = "total" }: { segments: ChartSegment[]; label: string; centerLabel?: string }) {
  const total = segments.reduce((n, s) => n + s.value, 0);
  const r = 38;
  const c = 2 * Math.PI * r;
  const gap = total > 0 && segments.filter((s) => s.value > 0).length > 1 ? 2 : 0;
  let offset = 0;
  const summary = segments.map((s) => `${s.label} ${s.value}`).join(", ");
  return (
    <figure className="flex flex-wrap items-center gap-6">
      <svg viewBox="0 0 100 100" role="img" aria-label={`${label}: ${summary}`} className="size-36 shrink-0 -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" strokeWidth="12" className="stroke-neutral-bg" />
        {total > 0 &&
          segments.map((s, i) => {
            if (!s.value) return null;
            const len = (s.value / total) * c;
            const el = (
              <circle
                key={s.label}
                cx="50"
                cy="50"
                r={r}
                fill="none"
                strokeWidth="12"
                strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
                strokeDashoffset={-offset}
                className={cx("transition-[stroke-dasharray] duration-700", STROKE[toneOf(s, i)])}
              />
            );
            offset += len;
            return el;
          })}
        <g className="rotate-90 [transform-origin:50%_50%]">
          <text x="50" y="49" textAnchor="middle" className="fill-text font-mono text-[18px] font-semibold">{total}</text>
          <text x="50" y="62" textAnchor="middle" className="fill-muted text-[8px]">{centerLabel}</text>
        </g>
      </svg>
      <figcaption className="min-w-40 flex-1"><Legend segments={segments} /></figcaption>
    </figure>
  );
}

/** Vertical bars with the value above each bar and the label below. */
export function Histogram({ segments, label }: { segments: ChartSegment[]; label: string }) {
  const max = Math.max(1, ...segments.map((s) => s.value));
  const summary = segments.map((s) => `${s.label} ${s.value}`).join(", ");
  return (
    <figure>
      <div role="img" aria-label={`${label}: ${summary}`} className="flex h-40 items-end gap-2 border-b border-border px-1">
        {segments.map((s, i) => (
          <div key={s.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <span aria-hidden className="font-mono text-xs font-semibold text-text tabular-nums">{s.value}</span>
            <div
              aria-hidden
              className={cx("w-full max-w-12 rounded-t-md bg-linear-to-b from-white/30 to-transparent shadow-btn-soft transition-[height] duration-700", FILL[toneOf(s, i)])}
              style={{ height: `${(s.value / max) * 82}%`, minHeight: s.value ? 4 : 0 }}
            />
          </div>
        ))}
      </div>
      <figcaption className="mt-1.5 flex gap-2 px-1">
        {segments.map((s) => (
          <span key={s.label} className="min-w-0 flex-1 truncate text-center text-xs font-semibold text-muted">{s.label}</span>
        ))}
      </figcaption>
    </figure>
  );
}
