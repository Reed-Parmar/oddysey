/** IMP-01 / IMP-02 three-step import: choose file → dry-run preview → apply (admin.md §3.2, §9.3, §12.6). */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError, errorMessage, type ErrorDetail } from "@/api/errors";
import type { ImportResult } from "@/api/types";
import { uploadMultipart } from "@/api/upload";
import { DataTable, FileField, FormField, useToast, type Column } from "@/components/shared";
import { Alert, Button, Dialog } from "@/components/ui";

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
    { key: "row", header: "Row", cell: (p) => p.row ?? "", className: "w-16 tabular-nums" },
    { key: "col", header: "Column", cell: (p) => p.column },
    { key: "msg", header: "Problem", cell: (p) => p.message },
  ];
  return (
    <div className="flex flex-col gap-2">
      <Alert variant="danger">
        {problems.length} {problems.length === 1 ? "problem" : "problems"} found. Fix the file and upload again. Nothing was imported.
      </Alert>
      <DataTable rows={problems.map((p, i) => ({ ...p, i }))} columns={cols} rowKey={(p) => String(p.i)} caption="Import problems" />
    </div>
  );
}

/** Dry-run summary + gated Apply button. Pure presentation: tested in ImportPanel.test.tsx. */
export function ImportPreview({ result, noun, applying, onApply }: {
  result: ImportResult; noun: string; applying?: boolean; onApply: () => void;
}) {
  const problems = problemsFromResult(result);
  const canApply = problems.length === 0;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        {([["Rows", result.rows], ["New", result.created], ["Updated", result.updated], ["Unchanged", result.unchanged]] as const).map(([k, v]) => (
          <div key={k} className="rounded-md border border-border p-2">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="text-lg font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      {result.created_trades.length > 0 && (
        <p className="text-sm"><span className="font-medium">New trades: </span>{result.created_trades.join(", ")}</p>
      )}
      {result.created_skills.length > 0 && (
        <p className="text-sm"><span className="font-medium">New skills: </span>{result.created_skills.join(", ")}</p>
      )}
      {result.warnings.length > 0 && (
        <Alert variant="warning" title="Warnings">
          <ul className="list-disc pl-5">{result.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        </Alert>
      )}
      <ImportErrorTable problems={problems} />
      <div className="flex flex-col items-end gap-1">
        <Button onClick={onApply} disabled={!canApply} loading={applying}>Apply import</Button>
        {!canApply && <p className="text-xs text-muted">Fix every problem before applying.</p>}
        {canApply && <p className="text-xs text-muted">Preview only: nothing has been written yet. Apply to import {result.rows} {noun}.</p>}
      </div>
    </div>
  );
}

type Envelope = { data: ImportResult };

export function ImportDialog({ open, onClose, endpoint, cycleId, noun, onApplied }: {
  open: boolean; onClose: () => void; endpoint: ImportEndpoint; cycleId: string; noun: string;
  onApplied: (r: ImportResult) => void;
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

  return (
    <Dialog open={open} onClose={busy ? () => {} : close} title={`Import ${noun}`}>
      <div className="flex flex-col gap-4">
        <FormField label="Spreadsheet (.xlsx or .csv, max 5 MB)" htmlFor="import-file" hint="Row numbers in problems refer to the sheet rows.">
          <FileField id="import-file" accept=".xlsx,.csv" maxBytes={MAX_BYTES} error={fileError}
            onChange={(f) => { setFile(f); setPreview(null); setApplyProblems([]); setFileError(undefined); }} />
        </FormField>
        <div className="flex justify-end">
          <Button variant={preview ? "secondary" : "primary"} disabled={!file || busy} loading={dry.isPending} onClick={() => dry.mutate()}>
            {preview ? "Re-run preview" : "Preview (dry run)"}
          </Button>
        </div>
        {progress != null && (
          <div aria-live="polite" className="flex items-center gap-2 text-xs text-muted">
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-neutral-bg">
              <div className="h-full bg-primary" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            Uploading {Math.round(progress * 100)}%
          </div>
        )}
        {otherError != null && <Alert variant="danger">{errorMessage(otherError)}</Alert>}
        {applyProblems.length > 0 && <ImportErrorTable problems={applyProblems} />}
        {preview && applyProblems.length === 0 && (
          <ImportPreview result={preview} noun={noun} applying={apply.isPending} onApply={() => apply.mutate()} />
        )}
      </div>
    </Dialog>
  );
}
