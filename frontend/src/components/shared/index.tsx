/** Shared building blocks (frontend.md §4). Page-state standard: frontend.md §7. */
import {
  ArrowRight,
  CaretDown,
  CaretUpDown,
  Check,
  LockKey,
  MagnifyingGlass,
  Tray,
  WarningCircle,
} from "@phosphor-icons/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { ApiError, errorMessage } from "@/api/errors";
import type { PageMeta } from "@/api/types";
import { Alert, Button, Dialog, cx } from "@/components/ui";
import { formatDate, formatDateTime, formatScore } from "@/lib/format";

export { StatusBadge } from "./StatusBadge";
export { useToast } from "./Toaster";

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  /** Small context line above the title (e.g. a back link or section name). */
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1.5 text-sm font-semibold text-clay-ink">{eyebrow}</div>}
        <h1 className="text-2xl font-semibold tracking-tight text-text sm:text-[1.75rem]">{title}</h1>
        {description && <p className="mt-1.5 max-w-3xl text-[0.95rem] text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Back link for detail pages, rendered in PageHeader's eyebrow slot. */
export function BackLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 rounded text-sm font-medium text-muted transition-colors hover:text-primary">
      <ArrowRight aria-hidden size={14} className="rotate-180" />
      {children}
    </Link>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("skeleton-shimmer rounded-md bg-neutral-bg", className)} />;
}

/** True when the media query matches; without matchMedia (tests, old browsers) it returns `fallback`. */
export function useMediaQuery(query: string, fallback = true) {
  const get = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : fallback);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (!window.matchMedia) return;
    const m = window.matchMedia(query);
    const on = () => setMatches(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return matches;
}

/** Counts a number up when it first appears or changes. Assistive tech reads only the final value. */
export function CountUp({ value, duration = 700 }: { value: number; duration?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || typeof requestAnimationFrame === "undefined") {
      setShown(value);
      from.current = value;
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / duration);
      setShown(Math.round(a + (value - a) * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);
  return (
    <>
      <span aria-hidden>{shown}</span>
      <span className="sr-only">{value}</span>
    </>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div role="status" className="space-y-4 py-2">
      <span className="sr-only">{slow ? "Waking the server… this can take up to a minute." : label}</span>
      <div className="grid gap-4 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} aria-hidden className="rounded-xl border border-border bg-surface p-5 shadow-card">
            <div className="flex items-start justify-between">
              <Skeleton className="h-3.5 w-24" />
              <Skeleton className="size-9 rounded-lg" />
            </div>
            <Skeleton className="mt-3 h-7 w-16" />
            <Skeleton className="mt-2 h-3 w-32" />
          </div>
        ))}
      </div>
      <div aria-hidden className="space-y-3 rounded-xl border border-border bg-surface p-5 shadow-card">
        <div className="flex items-center gap-3">
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-11/12" />
        <Skeleton className="h-3 w-3/4" />
        <Skeleton className="h-3 w-5/6" />
      </div>
      {slow && <p aria-hidden className="text-sm text-muted">Waking the server… this can take up to a minute.</p>}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="relative flex flex-col items-center overflow-hidden rounded-xl border border-dashed border-border-strong bg-surface px-6 py-12 text-center">
      <EmptyArt>{icon ?? <Tray />}</EmptyArt>
      <p className="font-heading text-base font-semibold text-text">{title}</p>
      {description && <p className="mt-1 max-w-md text-sm text-muted">{description}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </div>
  );
}

/** Decorative illustration for empty states: a glossy icon tile on a soft colour halo with orbiting nodes. */
function EmptyArt({ children }: { children: ReactNode }) {
  return (
    <div aria-hidden className="relative mb-4 grid size-28 place-items-center">
      <svg viewBox="0 0 112 112" className="absolute inset-0 size-full">
        <circle cx="56" cy="56" r="54" fill="var(--color-primary)" fillOpacity="0.07" />
        <circle cx="56" cy="56" r="40" fill="var(--color-violet)" fillOpacity="0.06" stroke="var(--color-border-strong)" strokeDasharray="3 5" />
        <circle cx="96" cy="56" r="4" fill="var(--color-accent)" />
        <circle cx="28" cy="28" r="3" fill="var(--color-clay)" />
        <circle cx="34" cy="90" r="3.5" fill="var(--color-violet)" />
      </svg>
      <span className="tile-3d relative inline-flex size-14 items-center justify-center rounded-2xl bg-primary-soft text-primary [&>svg]:size-7">
        {children}
      </span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error instanceof ApiError && error.status === 404) return <NotFound />;
  if (error instanceof ApiError && error.status === 403) return <Forbidden />;
  const rid = error instanceof ApiError ? error.requestId : null;
  return (
    <div className="flex gap-3 rounded-xl border border-danger/25 bg-danger-bg p-4 text-sm text-danger" role="alert">
      <WarningCircle aria-hidden size={20} className="mt-0.5 shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">{errorMessage(error)}</p>
        {rid && (
          <p className="mt-1 text-xs">
            Request ID: <code className="select-all [overflow-wrap:anywhere]">{rid}</code>
          </p>
        )}
        {onRetry && (
          <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

const dashboardLink = (
  <Link className="inline-flex items-center gap-1 font-semibold text-primary hover:underline" to="/app">
    Go to my dashboard <ArrowRight aria-hidden size={14} />
  </Link>
);

export function NotFound() {
  return (
    <EmptyState
      icon={<MagnifyingGlass />}
      title="Not found"
      description="This page or record does not exist, or you do not have access to it."
      action={dashboardLink}
    />
  );
}

export function Forbidden() {
  return <EmptyState icon={<LockKey />} title="You don't have access to this page" action={dashboardLink} />;
}

export function ConfirmDialog({ open, title, message, confirmLabel = "Confirm", danger, loading, onConfirm, onClose }: {
  open: boolean; title: string; message: ReactNode; confirmLabel?: string; danger?: boolean; loading?: boolean;
  onConfirm: () => void; onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button variant={danger ? "danger" : "primary"} loading={loading} onClick={onConfirm}>{confirmLabel}</Button>
    </>}>
      <div className="text-sm leading-relaxed text-muted">{message}</div>
    </Dialog>
  );
}

export function FormField({ label, htmlFor, error, hint, children, required }: {
  label: string; htmlFor: string; error?: string; hint?: ReactNode; children: ReactNode; required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-semibold text-text">
        {label} {required && <span className="text-danger" aria-hidden>*</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && (
        <p className="flex items-center gap-1 text-xs font-medium text-danger" role="alert">
          <WarningCircle aria-hidden size={14} className="shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return <Alert variant="danger" icon={<WarningCircle />}>{errorMessage(error)}</Alert>;
}

export function Pagination({ meta, onPageChange }: { meta?: PageMeta; onPageChange: (page: number) => void }) {
  if (!meta || meta.total <= meta.page_size) return null;
  const pages = Math.ceil(meta.total / meta.page_size);
  return (
    <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center justify-between gap-3 text-sm">
      <span className="text-muted tabular-nums">
        Page {meta.page} of {pages} · {meta.total} items
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={meta.page <= 1} onClick={() => onPageChange(meta.page - 1)}>Previous</Button>
        <Button size="sm" variant="secondary" disabled={meta.page >= pages} onClick={() => onPageChange(meta.page + 1)}>Next</Button>
      </div>
    </nav>
  );
}

export type Column<T> = { key: string; header: ReactNode; cell: (row: T) => ReactNode; className?: string; sort?: string };

/**
 * Table with optional sort headers emitting exact sort strings. From md up it is a table (horizontal scroll if
 * needed); on phones each row becomes a card: the first column is the card title, the rest are labelled fields.
 */
export function DataTable<T>(props: {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; sort?: string; onSortChange?: (s: string) => void;
  onRowClick?: (row: T) => void; caption?: string;
}) {
  const { rows, columns, rowKey, sort, onSortChange, onRowClick, caption } = props;
  const wide = useMediaQuery("(min-width: 48rem)");
  if (!wide) return <DataCards {...props} />;
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-surface shadow-card">
      <table className="w-full text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="border-b border-border bg-surface-2">
          <tr>
            {columns.map((c) => {
              const active = !!c.sort && sort === c.sort;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={c.sort && onSortChange ? (active ? "descending" : "none") : undefined}
                  className={cx("px-4 py-3 text-xs font-semibold tracking-wide whitespace-nowrap text-muted uppercase", c.className)}
                >
                  {c.sort && onSortChange ? (
                    <button
                      type="button"
                      className={cx("-mx-1 inline-flex items-center gap-1 rounded px-1 uppercase transition-colors hover:text-text", active && "text-primary")}
                      onClick={() => onSortChange(c.sort!)}
                    >
                      {c.header}
                      {active ? <CaretDown aria-hidden size={12} weight="bold" /> : <CaretUpDown aria-hidden size={12} className="opacity-60" />}
                    </button>
                  ) : c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={cx("transition-colors even:bg-surface-2", onRowClick ? "cursor-pointer hover:bg-primary-soft" : "hover:bg-primary-soft/60")}
            >
              {columns.map((c) => <td key={c.key} className={cx("px-4 py-3 align-middle", c.className)}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DataCards<T>({ rows, columns, rowKey, sort, onSortChange, onRowClick, caption }: {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; sort?: string; onSortChange?: (s: string) => void;
  onRowClick?: (row: T) => void; caption?: string;
}) {
  const [first, ...rest] = columns;
  const sortable = onSortChange ? columns.filter((c) => c.sort) : [];
  return (
    <div className="space-y-3">
      {sortable.length > 0 && (
        <div role="group" aria-label="Sort by" className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="font-semibold text-muted">Sort:</span>
          {sortable.map((c) => (
            <button
              key={c.key}
              type="button"
              aria-pressed={sort === c.sort}
              onClick={() => onSortChange!(c.sort!)}
              className={cx(
                "min-h-8 rounded-full border px-3 font-semibold transition-colors",
                sort === c.sort ? "border-primary bg-primary-soft text-primary-ink" : "border-border-strong bg-surface text-muted hover:text-text",
              )}
            >
              {c.header}
            </button>
          ))}
        </div>
      )}
      <ul aria-label={caption} className="space-y-3">
        {rows.map((r) => (
          <li
            key={rowKey(r)}
            onClick={onRowClick ? () => onRowClick(r) : undefined}
            className={cx("rounded-xl border border-border bg-surface p-4 shadow-card", onRowClick && "cursor-pointer")}
          >
            {first && <div className="text-sm font-semibold text-text [overflow-wrap:anywhere]">{first.cell(r)}</div>}
            {rest.length > 0 && (
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm">
                {rest.map((c) => (
                  <div key={c.key} className="min-w-0">
                    <dt className="text-[0.7rem] font-semibold tracking-wide text-subtle uppercase">{c.header}</dt>
                    <dd className="mt-0.5 min-w-0 [overflow-wrap:anywhere]">{c.cell(r)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function scoreTone(pct: number) {
  if (pct >= 75) return "bg-success";
  if (pct >= 50) return "bg-primary";
  if (pct >= 30) return "bg-warning";
  return "bg-danger";
}

export function ScoreBar({ value, max = 100, label, tone }: {
  value: number | null | undefined; max?: number; label?: string;
  /** "auto" colours by band (always paired with the number); default is primary. */
  tone?: "primary" | "auto";
}) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-2.5" aria-label={label ? `${label}: ${value ?? "not set"} of ${max}` : undefined}>
      <div className="h-2 w-24 overflow-hidden rounded-full bg-neutral-bg">
        <div className={cx("h-full rounded-full transition-[width] duration-500", tone === "auto" ? scoreTone(pct) : "bg-primary")} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm font-semibold tabular-nums">{formatScore(value)}{max !== 100 ? <span className="font-normal text-muted"> / {max}</span> : ""}</span>
    </div>
  );
}

export function SkillChips({ skills, highlight }: { skills: { id?: string; name: string }[]; highlight?: Set<string> }) {
  if (!skills.length) return <span className="text-sm text-muted">None listed</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {skills.map((s) => {
        const hit = highlight?.has(s.name.toLowerCase());
        return (
          <li
            key={s.id ?? s.name}
            className={cx(
              "inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium",
              hit ? "border-success/30 bg-success-bg text-success" : "border-border bg-surface-2 text-neutral",
            )}
          >
            {hit && <Check aria-hidden size={12} weight="bold" />}
            {s.name}
            {hit && <span className="sr-only"> (matches)</span>}
          </li>
        );
      })}
    </ul>
  );
}

export function DateTime({ value, dateOnly }: { value?: string | null; dateOnly?: boolean }) {
  if (!value) return <span>—</span>;
  return <time dateTime={value} className="tabular-nums">{dateOnly ? formatDate(value) : formatDateTime(value)}</time>;
}

export function FileField({ id, accept, maxBytes = 10 * 1024 * 1024, onChange, error }: {
  id: string; accept?: string; maxBytes?: number; onChange: (f: File | null) => void; error?: string;
}) {
  const [local, setLocal] = useState<string>();
  return (
    <div>
      <input id={id} type="file" accept={accept}
        className="block w-full rounded-lg border border-dashed border-border-strong bg-surface-2 p-2 text-sm text-muted transition-colors hover:border-primary file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:bg-primary-soft file:px-3 file:py-2 file:font-semibold file:text-primary-ink"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          if (f && f.size > maxBytes) {
            setLocal(`File must be ${Math.round(maxBytes / 1024 / 1024)} MB or smaller`);
            onChange(null);
            e.target.value = "";
            return;
          }
          setLocal(undefined);
          onChange(f);
        }} />
      {(local || error) && <p className="mt-1 text-xs font-medium text-danger" role="alert">{local || error}</p>}
    </div>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-8 gap-y-1 text-sm sm:grid-cols-[max-content_1fr] sm:gap-y-3">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted max-sm:mt-2 max-sm:text-xs max-sm:font-semibold max-sm:uppercase max-sm:tracking-wide">{k}</dt>
          <dd className="font-medium text-text [overflow-wrap:anywhere]">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ---------------------------------------------------------------- data visualisation */

type Tone = "primary" | "success" | "warning" | "danger" | "neutral" | "accent";

const TONE_ICON: Record<Tone, string> = {
  primary: "bg-primary-soft text-primary",
  success: "bg-success-bg text-success",
  warning: "bg-warning-bg text-warning",
  danger: "bg-danger-bg text-danger",
  neutral: "bg-neutral-bg text-neutral",
  accent: "bg-accent-soft text-accent-ink",
};

/** KPI tile: big number, label, optional hint and link. */
export function StatCard({ label, value, hint, icon, tone = "primary", to }: {
  label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: Tone; to?: string;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-3">
        <p className="text-sm font-medium text-muted">{label}</p>
        {icon && (
          <span aria-hidden className={cx("tile-3d inline-flex size-9 shrink-0 items-center justify-center rounded-lg [&>svg]:size-5", TONE_ICON[tone])}>
            {icon}
          </span>
        )}
      </div>
      <p className="mt-1 font-heading text-3xl font-semibold tracking-tight text-text tabular-nums">{typeof value === "number" ? <CountUp value={value} /> : value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </>
  );
  const base = "block rounded-xl border border-border bg-surface p-5 shadow-card";
  return to ? (
    <Link to={to} className={cx(base, "transition-[border-color,box-shadow] duration-150 hover:border-primary/40 hover:shadow-raised")}>
      {body}
    </Link>
  ) : (
    <div className={base}>{body}</div>
  );
}

const TONE_BAR: Record<Tone, string> = {
  primary: "bg-primary",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-subtle",
  accent: "bg-accent",
};

/** Labelled horizontal meter (e.g. capacity filled, completion rate). */
export function Meter({ label, value, max, tone = "primary", valueLabel, ariaLabel }: {
  label: ReactNode; value: number; max: number; tone?: Tone; valueLabel?: ReactNode;
  /** Accessible name when `label` is not plain text. */
  ariaLabel?: string;
}) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate font-medium text-text">{label}</span>
        <span className="shrink-0 text-muted tabular-nums">{valueLabel ?? `${value} / ${max}`}</span>
      </div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
        aria-label={ariaLabel ?? (typeof label === "string" ? label : undefined)}
        className="h-2 overflow-hidden rounded-full bg-neutral-bg"
      >
        <div className={cx("h-full rounded-full transition-[width] duration-500", TONE_BAR[tone])} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const SERIES = ["bg-chart-1", "bg-chart-2", "bg-chart-3", "bg-chart-4", "bg-chart-5"];

/** Proportion bar with a legend that carries the numbers (no colour-only meaning). */
export function StackedBar({ segments, label }: {
  segments: { label: string; value: number; className?: string }[]; label: string;
}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  const summary = segments.map((s) => `${s.label} ${s.value}`).join(", ");
  return (
    <figure>
      <div role="img" aria-label={`${label}: ${summary}`} className="flex h-3.5 w-full gap-0.5 overflow-hidden rounded-full bg-neutral-bg shadow-[inset_0_1px_2px_rgb(0_0_0/0.08)]">
        {total > 0 &&
          segments.map((s, i) =>
            s.value > 0 ? (
              <div key={s.label} className={cx("h-full bg-linear-to-b from-white/25 to-transparent transition-[width] duration-700 first:rounded-l-full last:rounded-r-full", s.className ?? SERIES[i % SERIES.length])} style={{ width: `${(s.value / total) * 100}%` }} />
            ) : null,
          )}
      </div>
      <figcaption className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        {segments.map((s, i) => (
          <span key={s.label} className="inline-flex items-center gap-2">
            <span aria-hidden className={cx("size-2.5 rounded-sm", s.className ?? SERIES[i % SERIES.length])} />
            <span className="text-muted">{s.label}</span>
            <span className="font-semibold tabular-nums">{s.value}</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** Initials avatar (decorative; the name is always shown next to it). */
export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join("") || "?";
  return (
    <span aria-hidden className={cx(
      "inline-flex shrink-0 items-center justify-center rounded-full bg-primary-soft font-semibold text-primary-ink",
      size === "sm" ? "size-7 text-xs" : "size-9 text-sm",
    )}>
      {initials}
    </span>
  );
}

/** Ordered lifecycle steps (e.g. student journey). */
export function Steps({ steps }: { steps: { label: string; state: "done" | "current" | "todo"; hint?: ReactNode }[] }) {
  return (
    <ol className="grid gap-3 sm:grid-cols-[repeat(auto-fit,minmax(140px,1fr))]">
      {steps.map((s, i) => (
        <li key={s.label} className="flex items-start gap-3 sm:flex-col sm:gap-2" aria-current={s.state === "current" ? "step" : undefined}>
          <span aria-hidden className={cx(
            "inline-flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold",
            s.state === "done" && "bg-success text-white",
            s.state === "current" && "bg-primary text-white ring-4 ring-primary/15",
            s.state === "todo" && "border border-border-strong bg-surface text-muted",
          )}>
            {s.state === "done" ? <Check size={14} weight="bold" /> : i + 1}
          </span>
          <div className="min-w-0">
            <p className={cx("text-sm font-semibold", s.state === "todo" ? "text-muted" : "text-text")}>
              {s.label}
              <span className="sr-only"> ({s.state === "done" ? "done" : s.state === "current" ? "current step" : "not started"})</span>
            </p>
            {s.hint && <p className="mt-0.5 text-xs text-muted">{s.hint}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
