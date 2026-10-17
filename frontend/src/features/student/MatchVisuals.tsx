/** Presentation-only visuals for the trainee's My Project hero: match gauge and deadline chip. */
import { CalendarBlank, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

import { formatScore } from "@/lib/format";
import { label } from "@/lib/statusLabels";

const R = 52;
const CIRC = 2 * Math.PI * R;

/** Radial 0–100 ring; animates its stroke on mount (static under reduced motion via the global CSS). */
export function MatchGauge({ score, mode }: { score: number | null; mode: string | null }) {
  const value = score == null ? 0 : Math.max(0, Math.min(100, score));
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(value));
    return () => cancelAnimationFrame(id);
  }, [value]);
  const text = formatScore(score);

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative size-36 sm:size-40">
        <svg
          viewBox="0 0 120 120"
          className="size-full -rotate-90"
          role="img"
          aria-label={score == null ? "Match score not available" : `Match score ${text} out of 100`}
        >
          <circle cx="60" cy="60" r={R} fill="none" strokeWidth="10" className="stroke-surface-2" />
          <circle
            cx="60"
            cy="60"
            r={R}
            fill="none"
            strokeWidth="10"
            strokeLinecap="round"
            className="stroke-primary transition-[stroke-dashoffset] duration-1000 ease-out"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - shown / 100)}
          />
        </svg>
        <div aria-hidden className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-mono text-3xl font-semibold text-text tabular-nums sm:text-4xl">{text}</span>
          <span className="text-xs text-muted">match / 100</span>
        </div>
      </div>
      {mode && <span className="rounded-full bg-primary-soft px-2.5 py-0.5 text-xs font-medium text-primary-ink">{label("matchMode", mode)[0]}</span>}
    </div>
  );
}

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "12 days left" / "Due today" / "3 days overdue", in calendar days. */
export function DeadlineChip({ deadline }: { deadline: string }) {
  const due = new Date(deadline);
  const days = Math.round((startOfDay(due) - startOfDay(new Date())) / DAY);
  const overdue = days < 0 || (days === 0 && Date.now() > due.getTime());
  const text = days < 0
    ? `${-days} ${days === -1 ? "day" : "days"} overdue`
    : days === 0
      ? overdue ? "Overdue today" : "Due today"
      : `${days} ${days === 1 ? "day" : "days"} left`;
  const tone = overdue ? "bg-danger-bg text-danger" : days <= 3 ? "bg-warning-bg text-warning" : "bg-surface-2 text-muted";
  const Icon = overdue || days <= 3 ? WarningCircle : CalendarBlank;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums ${tone}`}>
      <Icon aria-hidden size={14} weight="bold" />
      {text}
    </span>
  );
}
