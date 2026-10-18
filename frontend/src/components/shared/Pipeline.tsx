/**
 * Automation pipeline (n8n-style connected nodes on a dot-grid canvas). Presentation only: every stage status is
 * derived by the caller from real API data; this component never invents progress.
 * Layout: one column on phones, a 2-column serpentine on tablets, a `columns`-wide serpentine from xl.
 */
import { CheckCircle, CircleDashed, CircleNotch, WarningCircle, XCircle } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { buttonStyles, cx } from "@/components/ui";

export type PipelineStatus = "done" | "active" | "waiting" | "attention" | "error" | "idle";

export type PipelineStage = {
  key: string;
  title: string;
  icon: ReactNode;
  status: PipelineStatus;
  /** Short status text on the node (defaults to the generic label for the status). */
  statusLabel?: string;
  metric?: ReactNode;
  metricLabel?: string;
  /** 0..1, drawn as a thin bar with the metric. */
  progress?: number;
  /** One or two sentences for the inspector. */
  summary: ReactNode;
  details?: { label: string; value: ReactNode }[];
  link?: { to: string; label: string };
  /** Extra inspector actions (for example a button). */
  actions?: ReactNode;
};

export const STATUS_META: Record<PipelineStatus, { label: string; tile: string; text: string; border: string }> = {
  done: { label: "Done", tile: "bg-success-bg text-success", text: "text-success", border: "border-border" },
  active: { label: "Running", tile: "bg-accent-soft text-accent", text: "text-accent-ink", border: "border-accent/45" },
  waiting: { label: "Waiting", tile: "bg-warning-bg text-warning", text: "text-warning", border: "border-border" },
  attention: { label: "Needs attention", tile: "bg-warning-bg text-warning", text: "text-warning", border: "border-warning/55" },
  error: { label: "Error", tile: "bg-danger-bg text-danger", text: "text-danger", border: "border-danger/50" },
  idle: { label: "Not started", tile: "bg-neutral-bg text-subtle", text: "text-subtle", border: "border-border border-dashed" },
};

const PROGRESS_SEGMENT: Record<PipelineStatus, string> = {
  done: "bg-success",
  active: "bg-accent",
  waiting: "bg-warning",
  attention: "bg-warning",
  error: "bg-danger",
  idle: "bg-neutral-bg",
};

export function StatusGlyph({ status, size = 14 }: { status: PipelineStatus; size?: number }) {
  switch (status) {
    case "done":
      return <CheckCircle aria-hidden size={size} weight="fill" />;
    case "active":
      return <CircleNotch aria-hidden size={size} weight="bold" className="animate-spin [animation-duration:1.6s]" />;
    case "waiting":
      return (
        <span aria-hidden className="inline-flex items-center justify-center" style={{ width: size, height: size }}>
          <span className="size-2 animate-pulse-ring rounded-full bg-warning text-warning/50" />
        </span>
      );
    case "attention":
      return <WarningCircle aria-hidden size={size} weight="fill" />;
    case "error":
      return <XCircle aria-hidden size={size} weight="fill" />;
    default:
      return <CircleDashed aria-hidden size={size} weight="bold" />;
  }
}

/** Status text with its glyph (never colour alone). */
export function PipelineStatusChip({ status, label }: { status: PipelineStatus; label?: string }) {
  const m = STATUS_META[status];
  return (
    <span className={cx("inline-flex min-w-0 items-center gap-1.5 text-xs font-semibold", m.text)}>
      <StatusGlyph status={status} />
      <span className="truncate">{label ?? m.label}</span>
    </span>
  );
}

function cell(i: number, per: number) {
  const r = Math.floor(i / per);
  const c = r % 2 === 0 ? i % per : per - 1 - (i % per);
  return { r: r + 1, c: c + 1 };
}

function direction(i: number, per: number) {
  const r = Math.floor(i / per);
  if (Math.floor((i + 1) / per) !== r) return "down";
  return r % 2 === 0 ? "right" : "left";
}

function defaultSelection(stages: PipelineStage[]) {
  const find = (...s: PipelineStatus[]) => stages.find((x) => s.includes(x.status))?.key;
  return find("error", "attention") ?? find("active", "waiting") ?? stages[stages.length - 1]?.key ?? null;
}

/**
 * Keys of stages whose status or metric changed since the previous render with data (not on first render).
 * Used to flash a node once when a refresh brings real new numbers.
 */
function useChangedStages(stages: PipelineStage[]) {
  const prev = useRef<Map<string, string> | null>(null);
  const [changed, setChanged] = useState<{ keys: Set<string>; tick: number }>({ keys: new Set(), tick: 0 });
  const sig = stages.map((s) => `${s.key}:${s.status}:${String(s.metric ?? "")}`).join("|");
  useEffect(() => {
    const now = new Map(stages.map((s) => [s.key, `${s.status}:${String(s.metric ?? "")}`]));
    if (prev.current) {
      const keys = new Set([...now].filter(([k, v]) => prev.current!.get(k) !== v).map(([k]) => k));
      if (keys.size) setChanged((c) => ({ keys, tick: c.tick + 1 }));
    }
    prev.current = now;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sig` captures every field compared here
  }, [sig]);
  return changed;
}

export function Pipeline({ stages, columns = 4, label, toolbar, footer }: {
  stages: PipelineStage[];
  /** Nodes per row from the xl breakpoint. */
  columns?: number;
  /** Accessible name of the pipeline. */
  label: string;
  /** Rendered in the canvas header (live status, actions). */
  toolbar?: ReactNode;
  footer?: ReactNode;
}) {
  const uid = useId();
  const [selected, setSelected] = useState<string | null>(() => defaultSelection(stages));
  const current = stages.find((s) => s.key === selected) ?? null;
  const inspectorId = `${uid}-inspector`;
  const changed = useChangedStages(stages);
  const doneCount = stages.filter((s) => s.status === "done").length;
  const currentIdx = stages.findIndex((s) => s.status !== "done");

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-card">
      {toolbar && <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-3 sm:px-5">{toolbar}</div>}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border px-4 py-2.5 sm:px-5">
        <ol aria-hidden className="flex min-w-40 flex-1 gap-1">
          {stages.map((s) => (
            <li key={s.key} className={cx("h-1.5 flex-1 rounded-full", PROGRESS_SEGMENT[s.status])} />
          ))}
        </ol>
        <p className="text-xs font-semibold text-muted tabular-nums">
          {doneCount} of {stages.length} stages done
          {currentIdx >= 0 && <span className="font-normal"> · now at <span className="font-semibold text-text">{stages[currentIdx].title}</span></span>}
        </p>
      </div>
      <div className="bg-dot-grid px-4 py-6 sm:px-6 sm:py-8">
        <ol aria-label={label} className="pl-grid" style={{ "--cols": columns } as CSSProperties}>
          {stages.map((s, i) => {
            const md = cell(i, 2);
            const xl = cell(i, columns);
            const next = stages[i + 1];
            const m = STATUS_META[s.status];
            const isSel = s.key === selected;
            const isChanged = changed.keys.has(s.key);
            const nextChanged = !!next && changed.keys.has(next.key);
            const pct = s.progress == null ? null : Math.max(0, Math.min(1, s.progress));
            return (
              <li
                key={s.key}
                className="pl-node relative min-w-0 animate-slide-in"
                style={{ "--r2": md.r, "--c2": md.c, "--rx": xl.r, "--cx": xl.c, animationDelay: `${i * 40}ms`, animationFillMode: "both" } as CSSProperties}
              >
                <button
                  type="button"
                  aria-pressed={isSel}
                  aria-controls={inspectorId}
                  onClick={() => setSelected(isSel ? null : s.key)}
                  className={cx(
                    "group relative flex h-full w-full flex-col gap-2.5 rounded-xl border bg-surface p-3.5 text-left shadow-card",
                    m.border,
                    isSel && "border-primary! ring-3 ring-primary/15",
                  )}
                >
                  {isChanged && <span key={`c${changed.tick}`} aria-hidden className="pl-changed pointer-events-none absolute inset-0 rounded-xl" />}
                  <span className="flex items-start gap-3">
                    <span aria-hidden className={cx("tile-3d inline-flex size-9 shrink-0 items-center justify-center rounded-lg [&>svg]:size-[18px]", m.tile)}>
                      {s.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="text-sm leading-snug font-semibold text-text">{s.title}</span>
                        {i === currentIdx ? (
                          <span className="shrink-0 rounded-full bg-primary px-1.5 py-px text-[0.62rem] font-semibold tracking-wide text-primary-fg uppercase">Current</span>
                        ) : (
                          <span aria-hidden className="shrink-0 font-mono text-[0.68rem] text-subtle">{String(i + 1).padStart(2, "0")}</span>
                        )}
                      </span>
                      <span className="mt-0.5 flex"><PipelineStatusChip status={s.status} label={s.statusLabel} /></span>
                    </span>
                  </span>
                  {s.metric == null && pct == null && (
                    <span aria-hidden className="mt-auto block font-mono text-xl font-semibold text-border-strong">—</span>
                  )}
                  {(s.metric != null || pct != null) && (
                    <span className="mt-auto block">
                      {s.metric != null && (
                        <span className="flex items-baseline gap-1.5">
                          <span key={isChanged ? `m${changed.tick}` : "m"} className={cx("font-mono text-xl font-semibold tracking-tight text-text tabular-nums", isChanged && "pl-metric-in")}>{s.metric}</span>
                          {s.metricLabel && <span className="truncate text-xs text-muted">{s.metricLabel}</span>}
                        </span>
                      )}
                      {pct != null && (
                        <span aria-hidden className="mt-1.5 block h-1 overflow-hidden rounded-full bg-neutral-bg">
                          <span
                            className={cx(
                              "block h-full rounded-full bg-linear-to-r transition-[width] duration-500",
                              s.status === "error" ? "from-danger/70 to-danger" : s.status === "done" ? "from-accent to-success" : "from-primary-light to-violet",
                            )}
                            style={{ width: `${pct * 100}%` }}
                          />
                        </span>
                      )}
                    </span>
                  )}
                </button>
                {next && (
                  <span
                    key={nextChanged ? `p${changed.tick}` : "n"}
                    aria-hidden
                    className="pl-conn"
                    data-state={next.status}
                    data-pulse={nextChanged || undefined}
                    data-md={direction(i, 2)}
                    data-xl={direction(i, columns)}
                  />
                )}
              </li>
            );
          })}
        </ol>
      </div>
      <div id={inspectorId} aria-live="polite" className="border-t border-border">
        {current ? <Inspector stage={current} index={stages.indexOf(current)} onClose={() => setSelected(null)} /> : (
          <p className="px-5 py-4 text-sm text-muted">Select a stage to see what is happening in it.</p>
        )}
      </div>
      {footer && <div className="border-t border-border bg-surface-2 px-4 py-3 sm:px-5">{footer}</div>}
    </div>
  );
}

function Inspector({ stage: s, index, onClose }: { stage: PipelineStage; index: number; onClose: () => void }) {
  const m = STATUS_META[s.status];
  return (
    <section aria-label={`${s.title} details`} className="animate-fade-in px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <span aria-hidden className={cx("tile-3d inline-flex size-9 shrink-0 items-center justify-center rounded-lg [&>svg]:size-[18px]", m.tile)}>{s.icon}</span>
          <div className="min-w-0">
            <p className="font-mono text-[0.7rem] font-medium tracking-wide text-subtle uppercase">Stage {String(index + 1).padStart(2, "0")}</p>
            <h3 className="text-base font-semibold text-text">{s.title}</h3>
            <div className="mt-0.5"><PipelineStatusChip status={s.status} label={s.statusLabel} /></div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {s.actions}
          {s.link && <Link to={s.link.to} className={buttonStyles("secondary", "sm")}>{s.link.label}</Link>}
          <button type="button" onClick={onClose} className={buttonStyles("ghost", "sm")}>Close<span className="sr-only"> {s.title} details</span></button>
        </div>
      </div>
      <div className="mt-3 max-w-3xl text-sm leading-relaxed text-text">{s.summary}</div>
      {!!s.details?.length && (
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 lg:grid-cols-4">
          {s.details.map((d) => (
            <div key={d.label} className="min-w-0">
              <dt className="text-xs font-medium text-muted">{d.label}</dt>
              <dd className="mt-0.5 text-sm font-semibold text-text tabular-nums [overflow-wrap:anywhere]">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

/** Text legend for the status vocabulary. */
export function PipelineLegend({ statuses = ["done", "active", "waiting", "attention", "error", "idle"] }: { statuses?: PipelineStatus[] }) {
  return (
    <ul aria-label="Status legend" className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {statuses.map((s) => (
        <li key={s}><PipelineStatusChip status={s} /></li>
      ))}
    </ul>
  );
}
