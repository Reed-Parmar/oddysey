/** Helpers shared by the admin data pages (cycles, trainees, projects, users, overview). */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Cycle } from "@/api/types";
import { useCurrentCycle } from "@/app/AppShell";
import { Alert, Button, Input, Select } from "@/components/ui";

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
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">Cycle</span>
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
  if (!(error instanceof ApiError)) return <Alert variant="danger">{errorMessage(error)}</Alert>;
  const msg = extra?.[error.code] ?? CODE_MESSAGES[error.code] ?? error.message;
  const list = error.code !== "VALIDATION_ERROR" ? error.details.map((d) => d.message) : [];
  return (
    <Alert variant="danger" title={list.length ? msg : undefined}>
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
    <div className="flex items-start justify-between gap-2 rounded-md border border-warning/30 bg-warning-bg px-3 py-2 text-sm text-warning" role="status">
      <div>
        <p className="font-medium">Saved with warnings</p>
        <ul className="list-disc pl-5">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
      </div>
      <Button size="sm" variant="ghost" onClick={onDismiss} aria-label="Dismiss warnings">Dismiss</Button>
    </div>
  );
}

/** A disabled action with its reason shown next to it. */
export function Reason({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="text-xs text-muted">{children}</p>;
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

export function StatTile({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">{children}</div>;
}

export function LabeledSelect({ id, label, value, onChange, children }: {
  id: string; label: string; value: string; onChange: (v: string) => void; children: ReactNode;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>{children}</Select>
    </label>
  );
}

export function SearchInput({ id, label, value, onChange, placeholder }: {
  id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string;
}) {
  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <Input id={id} type="search" value={value} maxLength={100} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
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
            <li key={s} className="inline-flex items-center gap-1 rounded-full border border-border bg-neutral-bg px-2 py-0.5 text-xs">
              {s}
              {!disabled && (
                <button type="button" className="rounded px-1 hover:bg-surface" aria-label={`Remove ${s}`}
                  onClick={() => onChange(value.filter((x) => x !== s))}>✕</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
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
    <div className="flex flex-col gap-2">
      <Alert variant="success" title="Invitation created">
        This link is shown once. Copy it now; it expires in 7 days.
      </Alert>
      <label htmlFor="invite-url" className="text-sm font-medium">Invite link</label>
      <div className="flex gap-2">
        <Input id="invite-url" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
        <Button variant="secondary" onClick={() => {
          void navigator.clipboard.writeText(url).then(() => { setCopied(true); onCopied(); });
        }}>{copied ? "Copied" : "Copy link"}</Button>
      </div>
    </div>
  );
}
