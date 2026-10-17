/** Helpers shared by the admin data pages (cycles, trainees, projects, users, overview). */
import { ArrowRight, Check, Copy, Info, MagnifyingGlass, Warning, WarningCircle, X } from "@phosphor-icons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Cycle } from "@/api/types";
import { useCurrentCycle } from "@/app/AppShell";
import { Alert, Button, Input, Select, cx } from "@/components/ui";

// ---------------------------------------------------------------- reference data

export function useTrades() {
  return useQuery({ queryKey: qk.trades.list(), queryFn: () => call(api.GET("/api/v1/trades")), staleTime: 60_000 });
}

export function useAllCycles() {
  const params = { sort: "-created_at", page_size: 100 };
  return useQuery({
    queryKey: qk.cycles.list(params),
    queryFn: () => call(api.GET("/api/v1/cycles", { params: { query: params } })),
  });
}

export function useActiveSupervisors() {
  const params = { role: "supervisor" as const, status: "active" as const, sort: "full_name", page_size: 100 };
  return useQuery({
    queryKey: qk.users.list(params),
    queryFn: () => call(api.GET("/api/v1/admin/users", { params: { query: params } })),
  });
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/**
 * The cycle a list page is scoped to: the explicit selection, else the active cycle (CYC-01).
 * Returns the resolved Cycle object (from CYC-02) so pages can check `archived`.
 */
export function useScopedCycle(selectedId: string) {
  const current = useCurrentCycle();
  const all = useAllCycles();
  const active = current.data?.data ?? null;
  const cycles = all.data?.data ?? [];
  const id = selectedId || active?.id || "";
  const cycle: Cycle | null = cycles.find((c) => c.id === id) ?? (active && active.id === id ? active : null);
  return { id, cycle, active, cycles, isLoading: current.isLoading || all.isLoading, error: current.error ?? all.error };
}

export function CycleSelect({ value, onChange, cycles, activeId, id = "cycle-select" }: {
  value: string; onChange: (v: string) => void; cycles: Cycle[]; activeId?: string; id?: string;
}) {
  if (!cycles.length) return null;
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1.5 text-sm">
      <span className={FILTER_LABEL}>Cycle</span>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {!activeId && <option value="">Select a cycle</option>}
        {cycles.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}{c.id === activeId ? " (active)" : c.status === "archived" ? " (archived)" : ""}
          </option>
        ))}
      </Select>
    </label>
  );
}

// ---------------------------------------------------------------- invalidation

export function useInvalidate() {
  const qc = useQueryClient();
  return (...keys: readonly unknown[][]) => {
    for (const queryKey of keys) void qc.invalidateQueries({ queryKey });
  };
}

// ---------------------------------------------------------------- errors & notices

/** Code-specific messages (admin.md §9.2). Falls back to the server message. */
const CODE_MESSAGES: Record<string, string> = {
  SELF_MODIFICATION_FORBIDDEN: "You cannot change your own account",
  LAST_ADMIN: "At least one active admin is required",
  ACTIVE_CYCLE_EXISTS: "Archive the current cycle before creating a new one",
  INVITATION_EXISTS: "An open invitation already exists for this email or trainee; revoke it first",
};

/** Form/dialog-level alert: server message, plus every `details[].message` for state errors. */
export function ApiErrorAlert({ error, extra }: { error: unknown; extra?: Record<string, string> }) {
  if (!error) return null;
  if (!(error instanceof ApiError)) return <Alert variant="danger" icon={<WarningCircle />}>{errorMessage(error)}</Alert>;
  const msg = extra?.[error.code] ?? CODE_MESSAGES[error.code] ?? error.message;
  const list = error.code !== "VALIDATION_ERROR" ? error.details.map((d) => d.message) : [];
  return (
    <Alert variant="danger" icon={<WarningCircle />} title={list.length ? msg : undefined}>
      {list.length ? (
        <ul className="list-disc pl-5">{list.map((m, i) => <li key={i}>{m}</li>)}</ul>
      ) : error.code === "VALIDATION_ERROR" ? errorMessage(error) : msg}
    </Alert>
  );
}

/** Persistent inline warnings from `meta.warnings` (stay until dismissed). */
export function WarningsAlert({ warnings, onDismiss }: { warnings: string[]; onDismiss: () => void }) {
  if (!warnings.length) return null;
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border border-warning/30 bg-warning-bg px-4 py-3 text-sm text-warning" role="status">
      <div className="flex min-w-0 gap-3">
        <Warning aria-hidden size={18} className="mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold">Saved with warnings</p>
          <ul className="mt-0.5 list-disc pl-5">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </div>
      </div>
      <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="Dismiss warnings">Dismiss</Button>
    </div>
  );
}

/** A disabled action with its reason shown next to it. */
export function Reason({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="max-w-xs text-xs text-muted">{children}</p>;
}

/**
 * Lifecycle track (e.g. draft → published → archived). `linear` marks earlier stages as done;
 * otherwise only the current stage is highlighted. Status is always spelled out, never colour-only.
 */
export function StatusTrack({ stages, current, linear }: {
  stages: { key: string; label: string }[]; current: string; linear?: boolean;
}) {
  const at = stages.findIndex((s) => s.key === current);
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-2" aria-label="Lifecycle">
      {stages.map((s, i) => {
        const state = i === at ? "current" : linear && i < at ? "done" : "todo";
        return (
          <li key={s.key} className="flex items-center gap-2" aria-current={state === "current" ? "step" : undefined}>
            {i > 0 && <ArrowRight aria-hidden size={14} className="text-subtle" />}
            <span className={cx(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap",
              state === "current" && "border-primary/30 bg-primary-soft text-primary-ink",
              state === "done" && "border-success/25 bg-success-bg text-success",
              state === "todo" && "border-border bg-surface text-muted",
            )}>
              {state === "done" && <Check aria-hidden size={12} weight="bold" />}
              {state === "current" && <span aria-hidden className="size-1.5 rounded-full bg-primary" />}
              {s.label}
              <span className="sr-only">{state === "current" ? " (current)" : state === "done" ? " (done)" : ""}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** The standard banner for an archived (read-only) cycle. */
export function ReadOnlyBanner() {
  return <Alert variant="info" icon={<Info />}>Cycle is archived (read-only).</Alert>;
}

/** Maps ApiError field details onto react-hook-form `setError`. Returns true when something was mapped. */
export function applyFieldErrors(
  error: unknown,
  setError: (name: never, e: { message: string }) => void,
  known: readonly string[],
  extra: Record<string, string> = {},
): boolean {
  if (!(error instanceof ApiError)) return false;
  let mapped = false;
  for (const [field, message] of Object.entries(error.fieldErrors())) {
    if (known.includes(field)) {
      setError(field as never, { message });
      mapped = true;
    }
  }
  const target = extra[error.code];
  if (target && known.includes(target)) {
    setError(target as never, { message: error.message });
    mapped = true;
  }
  return mapped;
}

// ---------------------------------------------------------------- small UI

const FILTER_LABEL = "text-xs font-semibold tracking-wide text-muted uppercase";

type StatTone = "neutral" | "success" | "warning" | "danger" | "info" | "primary";
const STAT_DOT: Record<StatTone, string> = {
  neutral: "bg-subtle", success: "bg-success", warning: "bg-warning", danger: "bg-danger", info: "bg-info", primary: "bg-primary",
};

/** Compact secondary number inside a card (the big KPIs use StatCard). */
export function StatTile({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: StatTone }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface-2 px-3 py-2.5">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
        {tone && <span aria-hidden className={cx("size-2 shrink-0 rounded-full", STAT_DOT[tone])} />}
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-0.5 font-heading text-xl font-semibold text-text tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

/** Filter grid; wraps to one column on phones. Usually placed in a TableCard `toolbar`. */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4", className)}>{children}</div>;
}

export function LabeledSelect({ id, label, value, onChange, children }: {
  id: string; label: string; value: string; onChange: (v: string) => void; children: ReactNode;
}) {
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1.5 text-sm">
      <span className={FILTER_LABEL}>{label}</span>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>{children}</Select>
    </label>
  );
}

export function SearchInput({ id, label, value, onChange, placeholder }: {
  id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label htmlFor={id} className="flex min-w-0 flex-col gap-1.5 text-sm">
      <span className={FILTER_LABEL}>{label}</span>
      <span className="relative block">
        <MagnifyingGlass aria-hidden size={16} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle" />
        <Input id={id} type="search" value={value} maxLength={100} placeholder={placeholder} className="pl-9!"
          onChange={(e) => onChange(e.target.value)} />
      </span>
    </label>
  );
}

/**
 * Card that hosts a list: optional header, a filter toolbar band, an edge-to-edge DataTable
 * (its own border/shadow are flattened) and a footer (pagination; hidden when empty).
 */
export function TableCard({ title, description, icon, actions, toolbar, children, footer }: {
  title?: ReactNode; description?: ReactNode; icon?: ReactNode; actions?: ReactNode; toolbar?: ReactNode;
  children: ReactNode; footer?: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-surface shadow-card">
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-5 pb-4">
          <div className="flex min-w-0 items-start gap-3">
            {icon && (
              <span aria-hidden className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary [&>svg]:size-[18px]">
                {icon}
              </span>
            )}
            <div className="min-w-0">
              {title && <h2 className="text-base font-semibold text-text">{title}</h2>}
              {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {toolbar && <div className={cx("border-y border-border bg-surface-2 px-5 py-4", !(title || actions) && "border-t-0")}>{toolbar}</div>}
      <div className="[&>.overflow-x-auto]:rounded-none [&>.overflow-x-auto]:border-0 [&>.overflow-x-auto]:shadow-none">{children}</div>
      {footer && <div className="border-t border-border px-5 pb-4 empty:hidden">{footer}</div>}
    </section>
  );
}

/** Padding for loading / empty / error states rendered inside a TableCard. */
export function CardState({ children }: { children: ReactNode }) {
  return <div className="p-4 sm:p-5 [&>div.border-dashed]:border-0 [&>div.border-dashed]:py-10">{children}</div>;
}

const LINK_VARIANTS = {
  primary: "bg-primary text-primary-fg shadow-card hover:bg-primary-hover",
  secondary: "border border-border-strong bg-surface text-text shadow-card hover:border-subtle hover:bg-surface-2",
  ghost: "text-primary hover:bg-primary-soft",
};
const LINK_SIZES = { sm: "min-h-9 px-3 text-sm", md: "min-h-10 px-4 text-sm" };

/** A router Link that looks like a Button (navigation stays a link for a11y). */
export function LinkButton({ to, children, variant = "secondary", size = "md", icon, onClick, className }: {
  to: string; children: ReactNode; variant?: keyof typeof LINK_VARIANTS; size?: keyof typeof LINK_SIZES;
  icon?: ReactNode; onClick?: () => void; className?: string;
}) {
  return (
    <Link to={to} onClick={onClick} className={cx(
      "inline-flex items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-colors duration-150",
      LINK_SIZES[size], LINK_VARIANTS[variant], className,
    )}>
      {icon && <span aria-hidden className="inline-flex shrink-0 [&>svg]:size-4">{icon}</span>}
      {children}
    </Link>
  );
}

/** Inline text link with the standard primary styling. */
export function TextLink({ to, children, onClick }: { to: string; children: ReactNode; onClick?: (e: MouseEvent) => void }) {
  return (
    <Link to={to} onClick={onClick} className="font-medium text-primary underline-offset-2 hover:underline">{children}</Link>
  );
}

/** Action (button group) with its disabled reason underneath, right-aligned from `sm` up. */
export function ActionStack({ children, reason }: { children: ReactNode; reason?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-1 sm:items-end">
      <div className="flex flex-wrap gap-2">{children}</div>
      {reason ? <div className="sm:text-right"><Reason>{reason}</Reason></div> : null}
    </div>
  );
}

/** Compact capacity bar for table cells: filled / capacity, always with the numbers. */
export function CapacityBar({ value, max, label = "Capacity filled" }: { value: number; max: number; label?: string }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  const full = max > 0 && value >= max;
  return (
    <div role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}
      className="flex items-center gap-2 whitespace-nowrap">
      <span aria-hidden className="h-1.5 w-16 overflow-hidden rounded-full bg-neutral-bg">
        <span className={cx("block h-full rounded-full", full ? "bg-success" : "bg-primary")} style={{ width: `${pct}%` }} />
      </span>
      <span className="text-sm tabular-nums"><span className="font-semibold text-text">{value}</span><span className="text-muted"> / {max}</span></span>
    </div>
  );
}

/** A titled group of form fields (two columns from `md`). Lives inside the form's single disabled fieldset. */
export function FormSection({ title, description, children }: { title: string; description?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <div role="group" aria-labelledby={id} className="min-w-0 border-t border-border pt-5 first:border-t-0 first:pt-0">
      <div className="mb-3">
        <h3 id={id} className="text-sm font-semibold text-text">{title}</h3>
        {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </div>
  );
}

/** "a · b · c" metadata line for detail-page headers. */
export function MetaLine({ items }: { items: ReactNode[] }) {
  const shown = items.filter(Boolean);
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {shown.map((it, i) => (
        <span key={i} className="inline-flex items-center gap-2">
          {i > 0 && <span aria-hidden className="size-1 rounded-full bg-subtle" />}
          {it}
        </span>
      ))}
    </span>
  );
}

/** "any" | "true" | "false" select value → optional boolean query param. */
export const triState = (v: string) => (v === "true" ? true : v === "false" ? false : undefined);

/** Skill names editor with SKL-01 autocomplete (names; server resolves/creates). */
export function SkillsInput({ id, value, onChange, max = 15, disabled }: {
  id: string; value: string[]; onChange: (v: string[]) => void; max?: number; disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 250);
  const suggestions = useQuery({
    queryKey: qk.skills.list(q || undefined),
    queryFn: () => call(api.GET("/api/v1/skills", { params: { query: q ? { q } : {} } })),
    enabled: !disabled,
    staleTime: 60_000,
  });
  const add = (raw: string) => {
    const names = raw.split(",").map((s) => s.trim()).filter(Boolean);
    const next = [...value];
    for (const n of names) {
      if (n.length > 80) continue;
      if (!next.some((x) => x.toLowerCase() === n.toLowerCase()) && next.length < max) next.push(n);
    }
    onChange(next);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "Enter" || e.key === ",") && text.trim()) {
      e.preventDefault();
      add(text);
    }
  };
  const listId = `${id}-options`;
  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Selected skills">
          {value.map((s) => (
            <li key={s} className="inline-flex items-center gap-1 rounded-md border border-primary/20 bg-primary-soft py-0.5 pr-0.5 pl-2 text-xs font-medium text-primary-ink">
              {s}
              {!disabled && (
                <button type="button" className="inline-flex size-6 items-center justify-center rounded text-primary-ink/70 transition-colors hover:bg-surface hover:text-danger" aria-label={`Remove ${s}`}
                  onClick={() => onChange(value.filter((x) => x !== s))}><X aria-hidden size={12} weight="bold" /></button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex min-w-0 gap-2">
        <Input id={id} list={listId} value={text} disabled={disabled || value.length >= max} maxLength={80}
          placeholder={value.length >= max ? `Maximum ${max} skills` : "Type a skill and press Enter"}
          onChange={(e) => setText(e.target.value)} onKeyDown={onKey} />
        <Button variant="secondary" disabled={disabled || !text.trim() || value.length >= max} onClick={() => add(text)}>Add</Button>
      </div>
      <datalist id={listId}>
        {(suggestions.data?.data ?? []).map((s) => <option key={s.id} value={s.name} />)}
      </datalist>
    </div>
  );
}

/** ISO → value for <input type="datetime-local"> in the user's local time. */
export function toLocalInput(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** <input type="datetime-local"> value (local) → ISO UTC. */
export const fromLocalInput = (v: string) => new Date(v).toISOString();

/** Copy-once reveal of an invite URL (admin.md §12.5). Kept only in component state. */
export function InviteUrlReveal({ url, onCopied }: { url: string; onCopied: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <Alert variant="success" icon={<Check weight="bold" />} title="Invitation created">
        This link is shown once. Copy it now; it expires in 7 days.
      </Alert>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="invite-url" className="text-sm font-semibold text-text">Invite link</label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input id="invite-url" readOnly value={url} className="font-mono text-xs!" onFocus={(e) => e.currentTarget.select()} />
          <Button variant={copied ? "secondary" : "primary"} icon={copied ? <Check weight="bold" /> : <Copy />} onClick={() => {
            void navigator.clipboard.writeText(url).then(() => { setCopied(true); onCopied(); });
          }}>{copied ? "Copied" : "Copy link"}</Button>
        </div>
      </div>
    </div>
  );
}
