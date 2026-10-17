/** Shared building blocks (frontend.md §4). Page-state standard: frontend.md §7. */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

import { ApiError, errorMessage } from "@/api/errors";
import type { PageMeta } from "@/api/types";
import { Alert, Button, Dialog } from "@/components/ui";
import { formatDate, formatDateTime } from "@/lib/format";

export { StatusBadge } from "./StatusBadge";
export { useToast } from "./Toaster";

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function LoadingState({ label = "Loading…" }: { label?: string }) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), 5000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div role="status" className="flex items-center gap-3 py-10 text-sm text-muted">
      <span className="size-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      {slow ? "Waking the server… this can take up to a minute." : label}
    </div>
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-10 text-center">
      <p className="font-medium">{title}</p>
      {description && <p className="mt-1 text-sm text-muted">{description}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (error instanceof ApiError && error.status === 404) return <NotFound />;
  if (error instanceof ApiError && error.status === 403) return <Forbidden />;
  const rid = error instanceof ApiError ? error.requestId : null;
  return (
    <div className="rounded-lg border border-danger/30 bg-danger-bg p-4 text-sm text-danger" role="alert">
      <p className="font-medium">{errorMessage(error)}</p>
      {rid && (
        <p className="mt-1 text-xs">
          Request ID: <code className="select-all">{rid}</code>
        </p>
      )}
      {onRetry && (
        <Button variant="secondary" size="sm" className="mt-3" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function NotFound() {
  return <EmptyState title="Not found" description="This page or record does not exist, or you do not have access to it." action={<Link className="text-primary underline" to="/app">Go to my dashboard</Link>} />;
}

export function Forbidden() {
  return <EmptyState title="You don't have access to this page" action={<Link className="text-primary underline" to="/app">Go to my dashboard</Link>} />;
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
      <div className="text-sm">{message}</div>
    </Dialog>
  );
}

export function FormField({ label, htmlFor, error, hint, children, required }: {
  label: string; htmlFor: string; error?: string; hint?: ReactNode; children: ReactNode; required?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {label} {required && <span className="text-danger" aria-hidden>*</span>}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-muted">{hint}</p>}
      {error && <p className="text-xs text-danger" role="alert">{error}</p>}
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return <Alert variant="danger">{errorMessage(error)}</Alert>;
}

export function Pagination({ meta, onPageChange }: { meta?: PageMeta; onPageChange: (page: number) => void }) {
  if (!meta || meta.total <= meta.page_size) return null;
  const pages = Math.ceil(meta.total / meta.page_size);
  return (
    <div className="mt-3 flex items-center justify-between text-sm">
      <span className="text-muted">
        Page {meta.page} of {pages} · {meta.total} items
      </span>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={meta.page <= 1} onClick={() => onPageChange(meta.page - 1)}>Previous</Button>
        <Button size="sm" variant="secondary" disabled={meta.page >= pages} onClick={() => onPageChange(meta.page + 1)}>Next</Button>
      </div>
    </div>
  );
}

export type Column<T> = { key: string; header: ReactNode; cell: (row: T) => ReactNode; className?: string; sort?: string };

/** Table with optional sort headers emitting exact sort strings. Scrolls horizontally on small screens. */
export function DataTable<T>({ rows, columns, rowKey, sort, onSortChange, onRowClick, caption }: {
  rows: T[]; columns: Column<T>[]; rowKey: (row: T) => string; sort?: string; onSortChange?: (s: string) => void;
  onRowClick?: (row: T) => void; caption?: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="border-b border-border bg-neutral-bg text-xs uppercase text-muted">
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={`px-3 py-2 font-medium ${c.className ?? ""}`}>
                {c.sort && onSortChange ? (
                  <button type="button" className="inline-flex items-center gap-1 uppercase" onClick={() => onSortChange(c.sort!)}>
                    {c.header} {sort === c.sort ? "▾" : ""}
                  </button>
                ) : c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={rowKey(r)} onClick={onRowClick ? () => onRowClick(r) : undefined}
              className={`border-b border-border last:border-0 ${onRowClick ? "cursor-pointer hover:bg-neutral-bg" : ""}`}>
              {columns.map((c) => <td key={c.key} className={`px-3 py-2 align-top ${c.className ?? ""}`}>{c.cell(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ScoreBar({ value, max = 100, label }: { value: number | null | undefined; max?: number; label?: string }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex items-center gap-2" aria-label={label ? `${label}: ${value ?? "not set"} of ${max}` : undefined}>
      <div className="h-2 w-24 overflow-hidden rounded-full bg-neutral-bg">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-sm tabular-nums">{value == null ? "—" : value}{max !== 100 ? ` / ${max}` : ""}</span>
    </div>
  );
}

export function SkillChips({ skills, highlight }: { skills: { id?: string; name: string }[]; highlight?: Set<string> }) {
  if (!skills.length) return <span className="text-sm text-muted">None listed</span>;
  return (
    <ul className="flex flex-wrap gap-1.5">
      {skills.map((s) => (
        <li key={s.id ?? s.name} className={`rounded-full border px-2 py-0.5 text-xs ${highlight?.has(s.name.toLowerCase()) ? "border-success/40 bg-success-bg text-success" : "border-border bg-neutral-bg"}`}>
          {s.name}
        </li>
      ))}
    </ul>
  );
}

export function DateTime({ value, dateOnly }: { value?: string | null; dateOnly?: boolean }) {
  if (!value) return <span>—</span>;
  return <time dateTime={value}>{dateOnly ? formatDate(value) : formatDateTime(value)}</time>;
}

export function FileField({ id, accept, maxBytes = 10 * 1024 * 1024, onChange, error }: {
  id: string; accept?: string; maxBytes?: number; onChange: (f: File | null) => void; error?: string;
}) {
  const [local, setLocal] = useState<string>();
  return (
    <div>
      <input id={id} type="file" accept={accept} className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-surface file:px-3 file:py-2"
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
      {(local || error) && <p className="mt-1 text-xs text-danger" role="alert">{local || error}</p>}
    </div>
  );
}

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
