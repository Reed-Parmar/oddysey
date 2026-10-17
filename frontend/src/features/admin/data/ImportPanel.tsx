/** IMP-01 / IMP-02 three-step import: choose file → dry-run preview → apply (admin.md §3.2, §9.3, §12.6). */
import { Check, CloudArrowUp, FileXls, Info, Warning, WarningCircle } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { ApiError, errorMessage, type ErrorDetail } from "@/api/errors";
import type { ImportResult } from "@/api/types";
import { uploadMultipart } from "@/api/upload";
import { DataTable, FormField, useToast, type Column } from "@/components/shared";
import { Alert, Button, Dialog, cx } from "@/components/ui";
import { formatBytes } from "@/lib/format";

export type ImportEndpoint = "/admin/imports/trainees" | "/admin/imports/projects";
export type ImportProblem = { row: number | null; column: string; message: string };

const MAX_BYTES = 5 * 1024 * 1024;

/** Dry-run `errors[]` → table rows. File-level errors have `row: null`. */
export function problemsFromResult(r: ImportResult): ImportProblem[] {
  return sortProblems(r.errors.map((e) => ({ row: e.row, column: e.column ?? "File", message: e.message })));
}

/** 422 IMPORT_INVALID `details[]` (`field: "row 7: Column"` or `"file"`) → table rows. */
export function problemsFromDetails(details: ErrorDetail[]): ImportProblem[] {
  return sortProblems(details.map((d) => {
    const m = /^row (\d+): (.+)$/.exec(d.field);
    if (m) return { row: Number(m[1]), column: m[2], message: d.message };
    return { row: null, column: d.field === "file" || d.field === "body.file" ? "File" : d.field, message: d.message };
  }));
}

function sortProblems(p: ImportProblem[]): ImportProblem[] {
  return [...p].sort((a, b) => (a.row ?? -1) - (b.row ?? -1) || a.column.localeCompare(b.column));
}

export function ImportErrorTable({ problems }: { problems: ImportProblem[] }) {
  if (!problems.length) return null;
  const cols: Column<ImportProblem & { i: number }>[] = [
    { key: "row", header: "Row", cell: (p) => p.row ?? "", className: "w-16 font-semibold tabular-nums" },
    { key: "col", header: "Column", cell: (p) => <span className="font-medium whitespace-nowrap">{p.column}</span> },
    { key: "msg", header: "Problem", cell: (p) => <span className="text-danger">{p.message}</span> },
  ];
  return (
    <div className="flex flex-col gap-2">
      <Alert variant="danger" icon={<WarningCircle />}>
        {problems.length} {problems.length === 1 ? "problem" : "problems"} found. Fix the file and upload again. Nothing was imported.
      </Alert>
      <div className="max-h-72 overflow-y-auto rounded-xl">
        <DataTable rows={problems.map((p, i) => ({ ...p, i }))} columns={cols} rowKey={(p) => String(p.i)} caption="Import problems" />
      </div>
    </div>
  );
}

const SUMMARY_TONE = {
  Rows: "text-text",
  New: "text-success",
  Updated: "text-info",
  Unchanged: "text-muted",
} as const;

/** Dry-run summary + gated Apply button. Pure presentation: tested in ImportPanel.test.tsx. */
export function ImportPreview({ result, noun, applying, onApply }: {
  result: ImportResult; noun: string; applying?: boolean; onApply: () => void;
}) {
  const problems = problemsFromResult(result);
  const canApply = problems.length === 0;
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        {([["Rows", result.rows], ["New", result.created], ["Updated", result.updated], ["Unchanged", result.unchanged]] as const).map(([k, v]) => (
          <div key={k} className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
            <dt className="text-xs font-medium text-muted">{k}</dt>
            <dd className={cx("font-heading text-xl font-semibold tabular-nums", SUMMARY_TONE[k])}>{v}</dd>
          </div>
        ))}
      </dl>
      {result.created_trades.length > 0 && <NewNames label="New trades" names={result.created_trades} />}
      {result.created_skills.length > 0 && <NewNames label="New skills" names={result.created_skills} />}
      {result.warnings.length > 0 && (
        <Alert variant="warning" icon={<Warning />} title="Warnings">
          <ul className="list-disc pl-5">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Alert>
      )}
      <ImportErrorTable problems={problems} />
      <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
        {!canApply && <p className="text-sm text-muted">Fix every problem before applying.</p>}
        {canApply && (
          <p className="flex items-start gap-2 text-sm text-muted">
            <Info aria-hidden size={16} className="mt-0.5 shrink-0 text-info" />
            <span>Preview only: nothing has been written yet. Apply to import {result.rows} {noun}.</span>
          </p>
        )}
        <Button onClick={onApply} disabled={!canApply} loading={applying} icon={<Check weight="bold" />} className="shrink-0 self-end sm:self-auto">
          Apply import
        </Button>
      </div>
    </div>
  );
}

function NewNames({ label, names }: { label: string; names: string[] }) {
  return (
    <div className="flex flex-col gap-1.5 text-sm sm:flex-row sm:items-baseline sm:gap-3">
      <p className="shrink-0 font-semibold text-text">{label}</p>
      <ul className="flex flex-wrap gap-1.5" aria-label={label}>
        {names.map((n) => (
          <li key={n} className="rounded-md border border-accent/25 bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent-ink">{n}</li>
        ))}
      </ul>
    </div>
  );
}

/** File picker styled as a drop zone. The native input covers the zone, so click and drag-drop both work. */
function DropZone({ id, accept, maxBytes, file, error, onChange }: {
  id: string; accept: string; maxBytes: number; file: File | null; error?: string; onChange: (f: File | null) => void;
}) {
  const [local, setLocal] = useState<string>();
  const shown = local || error;
  return (
    <div>
      <div className={cx(
        "relative flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-7 text-center transition-colors duration-150",
        "has-[:focus-visible]:border-primary has-[:focus-visible]:ring-3 has-[:focus-visible]:ring-primary/15",
        shown ? "border-danger/50 bg-danger-bg" : file ? "border-primary/40 bg-primary-soft" : "border-border-strong bg-surface-2 hover:border-primary hover:bg-primary-soft/60",
      )}>
        <span aria-hidden className={cx(
          "inline-flex size-11 items-center justify-center rounded-full [&>svg]:size-6",
          file ? "bg-surface text-primary shadow-card" : "bg-surface text-muted shadow-card",
        )}>
          {file ? <FileXls /> : <CloudArrowUp />}
        </span>
        {file ? (
          <p className="max-w-full text-sm">
            <span className="block font-semibold [overflow-wrap:anywhere] text-text">{file.name}</span>
            <span className="text-muted tabular-nums">{formatBytes(file.size)} · click or drop to replace</span>
          </p>
        ) : (
          <p className="text-sm">
            <span className="font-semibold text-primary">Choose a file</span> <span className="text-muted">or drag it here</span>
            <span className="block text-xs text-muted">.xlsx or .csv, up to {Math.round(maxBytes / 1024 / 1024)} MB</span>
          </p>
        )}
        <input id={id} type="file" accept={accept}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
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
      </div>
      {shown && (
        <p className="mt-1.5 flex items-center gap-1 text-xs font-medium text-danger" role="alert">
          <WarningCircle aria-hidden size={14} className="shrink-0" />{shown}
        </p>
      )}
    </div>
  );
}

/** Choose → Preview → Apply indicator (presentational). */
function ImportSteps({ stage }: { stage: 0 | 1 | 2 }) {
  const labels = ["Choose file", "Preview (dry run)", "Apply"];
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs font-semibold" aria-label="Import steps">
      {labels.map((l, i) => {
        const state = i < stage ? "done" : i === stage ? "current" : "todo";
        return (
          <li key={l} className="flex items-center gap-2" aria-current={state === "current" ? "step" : undefined}>
            {i > 0 && <span aria-hidden className="h-px w-4 bg-border-strong sm:w-6" />}
            <span aria-hidden className={cx(
              "inline-flex size-5 items-center justify-center rounded-full text-[0.65rem]",
              state === "done" && "bg-success text-primary-fg",
              state === "current" && "bg-primary text-primary-fg",
              state === "todo" && "border border-border-strong text-muted",
            )}>
              {state === "done" ? <Check size={11} weight="bold" /> : i + 1}
            </span>
            <span className={state === "todo" ? "text-muted" : "text-text"}>{l}</span>
          </li>
        );
      })}
    </ol>
  );
}

type Envelope = { data: ImportResult };

export function ImportDialog({ open, onClose, endpoint, cycleId, noun, onApplied, notes }: {
  open: boolean; onClose: () => void; endpoint: ImportEndpoint; cycleId: string; noun: string;
  onApplied: (r: ImportResult) => void;
  /** Column notes shown above the file picker (e.g. which legacy columns are ignored). */
  notes?: ReactNode;
}) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [applyProblems, setApplyProblems] = useState<ImportProblem[]>([]);
  const [fileError, setFileError] = useState<string>();

  const send = (dryRun: boolean) => {
    const form = new FormData();
    form.append("file", file as File);
    form.append("cycle_id", cycleId);
    form.append("dry_run", dryRun ? "true" : "false");
    setProgress(0);
    return uploadMultipart<Envelope>(endpoint, form, { onProgress: setProgress }).finally(() => setProgress(null));
  };

  const fileErr = (e: unknown) => {
    if (e instanceof ApiError && e.code === "FILE_TOO_LARGE") setFileError("Max 5 MB");
    else if (e instanceof ApiError && e.code === "UNSUPPORTED_FILE_TYPE") setFileError("Upload an .xlsx or .csv file");
  };

  const dry = useMutation({
    mutationFn: () => send(true),
    onMutate: () => { setPreview(null); setApplyProblems([]); setFileError(undefined); },
    onSuccess: (res) => setPreview(res.data),
    onError: fileErr,
  });
  const apply = useMutation({
    mutationFn: () => send(false),
    onSuccess: (res) => {
      toast.success(`Imported ${res.data.rows} ${noun}`);
      onApplied(res.data);
      close();
    },
    onError: (e) => {
      fileErr(e);
      if (e instanceof ApiError && e.code === "IMPORT_INVALID") setApplyProblems(problemsFromDetails(e.details));
    },
  });

  function close() {
    setFile(null);
    setPreview(null);
    setApplyProblems([]);
    setFileError(undefined);
    dry.reset();
    apply.reset();
    onClose();
  }

  const busy = dry.isPending || apply.isPending;
  const otherError = [dry.error, apply.error].find(
    (e) => e && !(e instanceof ApiError && ["IMPORT_INVALID", "FILE_TOO_LARGE", "UNSUPPORTED_FILE_TYPE"].includes(e.code)),
  );
  const stage: 0 | 1 | 2 = preview && applyProblems.length === 0 ? 2 : file ? 1 : 0;

  return (
    <Dialog open={open} onClose={busy ? () => {} : close} title={`Import ${noun}`} size="lg"
      description="Upload the sheet, check the dry-run preview, then apply. Re-importing updates existing records by code.">
      <div className="flex flex-col gap-5">
        <ImportSteps stage={stage} />
        {notes && <Alert variant="info" icon={<Info />}>{notes}</Alert>}
        <FormField label="Spreadsheet (.xlsx or .csv, max 5 MB)" htmlFor="import-file" hint="Row numbers in problems refer to the sheet rows.">
          <DropZone id="import-file" accept=".xlsx,.csv" maxBytes={MAX_BYTES} file={file} error={fileError}
            onChange={(f) => { setFile(f); setPreview(null); setApplyProblems([]); setFileError(undefined); }} />
        </FormField>
        <div className="flex justify-end">
          <Button variant={preview ? "secondary" : "primary"} disabled={!file || busy} loading={dry.isPending} onClick={() => dry.mutate()}>
            {preview ? "Re-run preview" : "Preview (dry run)"}
          </Button>
        </div>
        {progress != null && (
          <div aria-live="polite" className="flex items-center gap-3 text-xs text-muted">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-bg">
              <div className="h-full rounded-full bg-primary transition-[width] duration-150" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <span className="tabular-nums">Uploading {Math.round(progress * 100)}%</span>
          </div>
        )}
        {otherError != null && <Alert variant="danger" icon={<WarningCircle />}>{errorMessage(otherError)}</Alert>}
        {applyProblems.length > 0 && <ImportErrorTable problems={applyProblems} />}
        {preview && applyProblems.length === 0 && (
          <section aria-label="Dry-run preview" className="rounded-xl border border-border p-4">
            <ImportPreview result={preview} noun={noun} applying={apply.isPending} onApply={() => apply.mutate()} />
          </section>
        )}
      </div>
    </Dialog>
  );
}
