/** /admin/trainees (ADR-031): trainees in the active cycles, their login status, and the IMP-04 account upload. */
import { DownloadSimple, GraduationCap, Info, Target, UploadSimple, UsersThree } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useSearchParams } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import type { ImportResult, Trainee, TraineeAccountImportResult } from "@/api/types";
import { Avatar, DataTable, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, StatusBadge, type Column } from "@/components/shared";
import { Alert, Button } from "@/components/ui";

import {
  CardState, CycleSelect, FilterBar, LabeledSelect, LinkButton, ReadOnlyBanner, SearchInput, TableCard, triState, useDebounced,
  useInvalidate, useScopedCycle,
} from "./common";
import { ImportDialog } from "./ImportPanel";

/** Header row of IMP-04 plus one clearly fake example row. Never contains a password. */
export const TRAINEE_TEMPLATE_CSV = [
  "Phone Number,Full Name,ITI Trade,ITI Name,Trade Theory Score (%),Workshop Practical Score (%),Safety Compliance Score (%),Primary Career Interest",
  "9000000001,Example Trainee,Electrician,ITI Example Centre,70,80,90,Solar installation",
].join("\r\n") + "\r\n";

const dash = <span className="text-muted">—</span>;

export function loginStatus(t: Trainee): "linked" | "default_password" | "none" {
  if (!t.account) return "none";
  return t.account.must_change_password ? "default_password" : "linked";
}

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([TRAINEE_TEMPLATE_CSV], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "trainee_accounts_template.csv";
  a.click();
  URL.revokeObjectURL(url);
}

const UPLOAD_NOTES = (
  <>
    Columns: <strong>Phone Number</strong>, <strong>Full Name</strong>, <strong>ITI Trade</strong> (several separated by commas),
    optional ITI Name, the three assessment scores (0–100) and Primary Career Interest. The phone number is the trainee's login
    and must be a 10-digit Indian mobile number. Re-uploading a phone number updates that trainee; it never creates a duplicate.
  </>
);

function RowResults({ result }: { result: ImportResult }) {
  const rows = (result as Partial<TraineeAccountImportResult>).results;
  if (!rows?.length) return null;
  const r = result as TraineeAccountImportResult;
  const cols: Column<(typeof rows)[number]>[] = [
    { key: "row", header: "Row", className: "w-14 tabular-nums", cell: (x) => x.row },
    { key: "phone", header: "Phone", cell: (x) => <span className="whitespace-nowrap tabular-nums">{x.phone}</span> },
    { key: "name", header: "Name", cell: (x) => x.full_name },
    { key: "trainee", header: "Trainee record", cell: (x) => <span className="capitalize">{x.trainee}{x.trainee_code ? ` · ${x.trainee_code}` : ""}</span> },
    { key: "account", header: "Login account", cell: (x) => (
      <span className="capitalize">{applied(r) ? x.account : x.account === "created" ? "will be created" : x.account === "linked" ? "will be linked" : "existing"}</span>
    ) },
  ];
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-muted">
        Login accounts: {r.accounts_created} new, {r.accounts_linked} linked, {r.accounts_existing} already set up.
      </p>
      <div className="max-h-72 overflow-y-auto rounded-xl">
        <DataTable rows={rows} columns={cols} rowKey={(x) => String(x.row)} caption="Rows in the file" />
      </div>
    </div>
  );
}

const applied = (r: ImportResult) => r.applied;

export function TraineesPage() {
  const [params, setParams] = useSearchParams();
  const scope = useScopedCycle(params.get("cycle") ?? "");
  const invalidate = useInvalidate();
  const [q, setQ] = useState("");
  const [login, setLogin] = useState("");
  const [page, setPage] = useState(1);
  const [uploadOpen, setUploadOpen] = useState(false);
  const dq = useDebounced(q.trim());

  const query = { cycle_id: scope.id || undefined, q: dq || undefined, linked: triState(login), page, page_size: 25, sort: "full_name" };
  const list = useQuery({
    queryKey: qk.trainees.list(query),
    queryFn: () => call(api.GET("/api/v1/trainees", { params: { query } })),
    enabled: scope.ready,
    placeholderData: keepPreviousData,
  });
  const archived = scope.cycle?.status === "archived";
  const filtered = !!(dq || login);
  const canUpload = !!scope.target && !archived;

  const cols: Column<Trainee>[] = [
    { key: "name", header: "Trainee", cell: (t) => (
      <span className="flex min-w-44 items-center gap-2.5">
        <Avatar name={t.full_name} size="sm" />
        <span className="min-w-0">
          <span className="block font-semibold">{t.full_name}</span>
          <span className="block text-xs text-muted tabular-nums">{t.trainee_code}</span>
        </span>
      </span>
    ) },
    ...(scope.multi ? [{ key: "cycle", header: "Cycle", cell: (t: Trainee) => <span className="whitespace-nowrap">{scope.nameOf(t.cycle_id)}</span> }] : []),
    { key: "phone", header: "Phone", cell: (t) => (t.phone ? <span className="whitespace-nowrap tabular-nums">{t.phone}</span> : dash) },
    { key: "trades", header: "Trades", cell: (t) => <span className="block min-w-28">{t.trades.map((x) => x.name).join(", ") || "—"}</span> },
    { key: "centre", header: "Centre", cell: (t) => t.centre_name ?? dash },
    { key: "login", header: "Account", cell: (t) => <StatusBadge kind="login" value={loginStatus(t)} /> },
    { key: "project", header: "Current project", cell: (t) => t.current_project ? (
      <span className="block min-w-44">{t.current_project.project.title}<span className="block text-xs text-muted">{t.current_project.project.project_code}</span></span>
    ) : <span className="text-muted">Not allocated</span> },
  ];

  const actions = (
    <>
      <Button variant="secondary" icon={<DownloadSimple />} onClick={downloadTemplate}>CSV template</Button>
      {canUpload && <Button variant="primary" icon={<UploadSimple />} onClick={() => setUploadOpen(true)}>Upload trainees</Button>}
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Trainees" eyebrow="Programme team"
        description="Every trainee in the active cycles (or the cycle you pick), their login account and current project. Upload a sheet to create trainees and their logins in one step."
        actions={actions} />
      {archived && <ReadOnlyBanner />}
      <Alert variant="info" icon={<Info />}>
        Trainees sign in with their phone number and the default password set by the programme team. They are asked to change it after they log in.
      </Alert>
      {scope.isLoading ? <LoadingState /> : scope.error ? <ErrorState error={scope.error} /> : !scope.ready ? (
        <EmptyState icon={<Target />} title="No active cycle" description="Create a cycle on the Overview page first; trainees belong to a cycle."
          action={<LinkButton variant="primary" to="/admin">Go to Overview</LinkButton>} />
      ) : (
        <TableCard title="Trainees" icon={<UsersThree />}
          description="Account shows whether the trainee can log in, and whether they still use the default password."
          toolbar={<FilterBar>
            <CycleSelect id="trn-cycle" value={scope.id} cycles={scope.cycles} actives={scope.actives}
              onChange={(v) => { setParams(v ? { cycle: v } : {}); setPage(1); }} />
            <SearchInput id="trn-q" label="Search" value={q} onChange={(v) => { setQ(v); setPage(1); }} placeholder="Name, ID, centre or phone" />
            <LabeledSelect id="trn-login" label="Account" value={login} onChange={(v) => { setLogin(v); setPage(1); }}>
              <option value="">Any</option>
              <option value="true">Has a login</option>
              <option value="false">No login</option>
            </LabeledSelect>
          </FilterBar>}
          footer={list.data?.data.length ? <Pagination meta={list.data.meta} onPageChange={setPage} /> : undefined}>
          {list.isLoading ? <CardState><LoadingState /></CardState> : list.error ? <CardState><ErrorState error={list.error} onRetry={() => void list.refetch()} /></CardState> :
            !list.data?.data.length ? (
              <CardState>
                <EmptyState icon={<GraduationCap />} title={filtered ? "No trainees match these filters" : "No trainees in this cycle yet"}
                  description={filtered ? undefined : "Upload a sheet of trainees with their phone numbers, or let trainees register themselves."}
                  action={!filtered && canUpload ? <Button icon={<UploadSimple />} onClick={() => setUploadOpen(true)}>Upload trainees</Button> : undefined} />
              </CardState>
            ) : (
              <DataTable rows={list.data.data} columns={cols} rowKey={(t) => t.id} caption="Trainees" />
            )}
        </TableCard>
      )}
      {canUpload && (
        <ImportDialog open={uploadOpen} onClose={() => setUploadOpen(false)} endpoint="/admin/imports/trainee-accounts" cycleId={scope.target}
          cycles={scope.allActive ? scope.actives : undefined} noun="trainees" notes={UPLOAD_NOTES}
          description="Upload the sheet, check the dry-run preview, then apply. Re-uploading updates trainees by phone number."
          details={(r) => <RowResults result={r} />}
          onApplied={() => invalidate(qk.trainees.all(), qk.progress.all(), qk.reports.all(), qk.automation.status())} />
      )}
    </div>
  );
}
