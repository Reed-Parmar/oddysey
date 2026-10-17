/** /admin/staff: users, staff invitations (with email delivery) and the staff spreadsheet import (ADR-017). */
import { zodResolver } from "@hookform/resolvers/zod";
import { EnvelopeSimple, FileXls, Prohibit, UserCheck, UserGear, UserPlus, Users, Warning, XCircle } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { api, call } from "@/api/client";
import { ApiError } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { AdminUser, Invitation, StaffImportResult, UserRole } from "@/api/types";
import { uploadMultipart } from "@/api/upload";
import { useAuth } from "@/auth/AuthProvider";
import {
  Avatar, ConfirmDialog, DataTable, DateTime, EmptyState, ErrorState, FileField, FormField, LoadingState, PageHeader, Pagination,
  StatusBadge, useToast, type Column,
} from "@/components/shared";
import { Alert, Button, Dialog, Input, Select, cx } from "@/components/ui";

import {
  ApiErrorAlert, CardState, FilterBar, InviteUrlReveal, LabeledSelect, SearchInput, TableCard, applyFieldErrors,
  useDebounced, useInvalidate,
} from "./common";

const ROLE_LABEL: Record<UserRole, string> = { student: "Student", supervisor: "Supervisor", admin: "Admin" };

const DELIVERY: Record<string, [string, string]> = {
  queued: ["Queued", "border-info/20 bg-info-bg text-info"],
  sent: ["Sent", "border-success/20 bg-success-bg text-success"],
  failed: ["Failed", "border-danger/20 bg-danger-bg text-danger"],
  not_configured: ["Email not configured", "border-border bg-neutral-bg text-neutral"],
};

function DeliveryBadge({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted">Not emailed</span>;
  const [text, cls] = DELIVERY[value] ?? [value, "border-border bg-neutral-bg text-neutral"];
  return <span className={cx("inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap", cls)}>{text}</span>;
}

export function StaffPage() {
  const [tab, setTab] = useState<"users" | "invitations">("users");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  return (
    <div>
      <PageHeader title="Staff & Invitations" eyebrow="Programme team"
        description="Supervisors and admins join by invitation only. Trainees register themselves and are enrolled automatically."
        actions={<>
          <Button variant="secondary" icon={<FileXls />} onClick={() => setImportOpen(true)}>Import staff</Button>
          <Button icon={<UserPlus />} onClick={() => setInviteOpen(true)}>Invite staff</Button>
        </>} />
      <div role="tablist" aria-label="Users and invitations" className="mb-4 inline-flex gap-1 rounded-lg border border-border bg-surface-2 p-1">
        {(["users", "invitations"] as const).map((t) => (
          <button key={t} role="tab" type="button" aria-selected={tab === t} onClick={() => setTab(t)}
            className={cx(
              "inline-flex min-h-9 items-center gap-2 rounded-md px-4 text-sm font-semibold transition-colors duration-150",
              tab === t ? "bg-surface text-primary shadow-card" : "text-muted hover:text-text",
            )}>
            {t === "users" ? <Users aria-hidden size={16} /> : <EnvelopeSimple aria-hidden size={16} />}
            {t === "users" ? "Users" : "Invitations"}
          </button>
        ))}
      </div>
      <div role="tabpanel">{tab === "users" ? <UsersTab /> : <InvitationsTab />}</div>
      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} />
      <StaffImportDialog open={importOpen} onClose={() => setImportOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------- users

type UserAction = { kind: "role"; user: AdminUser } | { kind: "status"; user: AdminUser };

function UsersTab() {
  const { user: me } = useAuth();
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [status, setStatus] = useState("");
  const [sort, setSort] = useState("full_name");
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<UserAction | null>(null);
  const dq = useDebounced(q.trim());
  const query = {
    q: dq || undefined, role: (role || undefined) as UserRole | undefined,
    status: (status || undefined) as AdminUser["status"] | undefined, sort, page, page_size: 20, staff: true,
  };
  const list = useQuery({
    queryKey: qk.users.list(query),
    queryFn: () => call(api.GET("/api/v1/admin/users", { params: { query } })),
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };
  const selfReason = "You cannot change your own account";

  const cols: Column<AdminUser>[] = [
    { key: "name", header: "Name", sort: "full_name", cell: (u) => (
      <span className="flex min-w-40 items-center gap-2.5">
        <Avatar name={u.full_name} size="sm" />
        <span className="font-semibold text-text">{u.full_name}{u.id === me?.id && <span className="ml-1.5 rounded bg-primary-soft px-1.5 py-0.5 text-xs font-semibold text-primary-ink">(you)</span>}</span>
      </span>
    ) },
    { key: "email", header: "Email", sort: "email", cell: (u) => <span className="break-all text-muted">{u.email}</span> },
    { key: "role", header: "Role", cell: (u) => <StatusBadge kind="role" value={u.role} /> },
    { key: "status", header: "Status", cell: (u) => <StatusBadge kind="user" value={u.status} /> },
    { key: "dept", header: "Department", cell: (u) => u.department ?? <span className="text-muted">—</span> },
    { key: "created", header: "Joined", sort: "-created_at", cell: (u) => <span className="whitespace-nowrap text-muted"><DateTime value={u.created_at} dateOnly /></span> },
    { key: "actions", header: <span className="sr-only">Actions</span>, cell: (u) => {
      const self = u.id === me?.id;
      return (
        <div className="flex min-w-52 flex-wrap justify-end gap-1.5" title={self ? selfReason : undefined}>
          <Button size="sm" variant="secondary" icon={<UserGear />} disabled={self} onClick={() => setAction({ kind: "role", user: u })}>Change role</Button>
          <Button size="sm" variant={u.status === "active" ? "danger" : "secondary"} icon={u.status === "active" ? <Prohibit /> : <UserCheck />}
            disabled={self} onClick={() => setAction({ kind: "status", user: u })}>
            {u.status === "active" ? "Disable" : "Enable"}
          </Button>
          {self && <span className="w-full text-right text-xs text-muted">{selfReason}</span>}
        </div>
      );
    } },
  ];

  return (
    <>
      <TableCard
        toolbar={<FilterBar>
          <SearchInput id="user-q" label="Search" value={q} onChange={reset(setQ)} placeholder="Name or email" />
          <LabeledSelect id="user-role" label="Role" value={role} onChange={reset(setRole)}>
            <option value="">All staff</option><option value="admin">Admin</option><option value="supervisor">Supervisor</option>
          </LabeledSelect>
          <LabeledSelect id="user-status" label="Status" value={status} onChange={reset(setStatus)}>
            <option value="">Any</option><option value="active">Active</option><option value="disabled">Disabled</option>
          </LabeledSelect>
          <LabeledSelect id="user-sort" label="Sort" value={sort} onChange={reset(setSort)}>
            <option value="full_name">Name</option><option value="email">Email</option><option value="-created_at">Newest first</option>
          </LabeledSelect>
        </FilterBar>}
        footer={list.data?.data.length ? <Pagination meta={list.data.meta} onPageChange={setPage} /> : undefined}>
        {list.isLoading ? <CardState><LoadingState /></CardState> : list.error ? <CardState><ErrorState error={list.error} onRetry={() => list.refetch()} /></CardState> :
          !list.data?.data.length ? <CardState><EmptyState icon={<Users />} title={dq || role || status ? "No users match these filters" : "No users yet"} /></CardState> : (
            <DataTable rows={list.data.data} columns={cols} rowKey={(u) => u.id} sort={sort} onSortChange={reset(setSort)} caption="Users" />
          )}
      </TableCard>
      {action?.kind === "role" && <RoleDialog user={action.user} onClose={() => setAction(null)} />}
      {action?.kind === "status" && <StatusDialog user={action.user} onClose={() => setAction(null)} />}
    </>
  );
}

const GUARD_MESSAGES = {
  SELF_MODIFICATION_FORBIDDEN: "You cannot change your own account",
  LAST_ADMIN: "At least one active admin is required",
};

function usePatchUser(user: AdminUser, onDone: () => void, successText: string) {
  const toast = useToast();
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { role?: UserRole; status?: AdminUser["status"] }) =>
      call(api.PATCH("/api/v1/admin/users/{user_id}", { params: { path: { user_id: user.id } }, body })),
    onSuccess: () => {
      invalidate(qk.users.all(), qk.projects.all(), qk.reports.all(), qk.automation.status());
      toast.success(successText);
      onDone();
    },
  });
}

function RoleDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const [role, setRole] = useState<UserRole>(user.role);
  const m = usePatchUser(user, onClose, `${user.full_name} is now ${ROLE_LABEL[role]}`);
  return (
    <Dialog open onClose={onClose} title={`Change role: ${user.full_name}`} description={<span className="inline-flex items-center gap-2">Current role <StatusBadge kind="role" value={user.role} /></span>} footer={<>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button loading={m.isPending} disabled={role === user.role} onClick={() => m.mutate({ role })}>Save role</Button>
    </>}>
      <div className="flex flex-col gap-3">
        <ApiErrorAlert error={m.error} extra={GUARD_MESSAGES} />
        <FormField label="Role" htmlFor="role-select" hint="Supervisors with projects must have them reassigned before changing role.">
          <Select id="role-select" value={role} onChange={(e) => setRole(e.target.value as UserRole)}>
            <option value="student">Student</option><option value="supervisor">Supervisor</option><option value="admin">Admin</option>
          </Select>
        </FormField>
      </div>
    </Dialog>
  );
}

function StatusDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const disabling = user.status === "active";
  const m = usePatchUser(user, onClose, `${user.full_name} ${disabling ? "disabled" : "enabled"}`);
  const projectParams = { supervisor_id: user.id, page_size: 100 };
  const supProjects = useQuery({
    queryKey: qk.projects.list(projectParams),
    queryFn: () => call(api.GET("/api/v1/projects", { params: { query: projectParams } })),
    enabled: disabling && user.role === "supervisor",
  });
  const activeProjects = (supProjects.data?.data ?? []).filter((p) => p.status !== "archived").length;
  const message = (
    <div className="flex flex-col gap-2">
      <p>{disabling ? `${user.full_name} will be signed out and unable to use the app until re-enabled.` : `${user.full_name} will be able to sign in again.`}</p>
      {disabling && user.role === "supervisor" && (supProjects.isLoading ? <p className="text-muted">Checking assigned projects…</p> :
        activeProjects > 0 && <Alert variant="warning" icon={<Warning />}>This supervisor has {activeProjects} active project{activeProjects === 1 ? "" : "s"}. Their trainees will have no evaluator until you choose another supervisor on each project.</Alert>)}
      <ApiErrorAlert error={m.error} extra={GUARD_MESSAGES} />
    </div>
  );
  return (
    <ConfirmDialog open title={`${disabling ? "Disable" : "Enable"} ${user.full_name}?`} message={message} danger={disabling}
      confirmLabel={disabling ? "Disable" : "Enable"} loading={m.isPending} onClose={onClose}
      onConfirm={() => m.mutate({ status: disabling ? "disabled" : "active" })} />
  );
}

// ---------------------------------------------------------------- invitations

function InvitationsTab() {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [status, setStatus] = useState("pending");
  const [role, setRole] = useState("");
  const [page, setPage] = useState(1);
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const query = {
    status: (status || undefined) as Invitation["status"] | undefined, role: (role || undefined) as UserRole | undefined,
    sort: "-created_at" as const, page, page_size: 20, staff: true,
  };
  const list = useQuery({
    queryKey: qk.invitations.list(query),
    queryFn: () => call(api.GET("/api/v1/admin/invitations", { params: { query } })),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => call(api.POST("/api/v1/admin/invitations/{invitation_id}/revoke", { params: { path: { invitation_id: id } } })),
    onSuccess: () => {
      invalidate(qk.invitations.all(), qk.reports.all());
      toast.success("Invitation revoked");
      setRevoking(null);
    },
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  const cols: Column<Invitation>[] = [
    { key: "email", header: "Email", cell: (i) => (
      <span className="flex min-w-48 items-center gap-2 font-medium break-all text-text"><EnvelopeSimple aria-hidden size={16} className="shrink-0 text-subtle" />{i.email}</span>
    ) },
    { key: "name", header: "Name", cell: (i) => i.full_name ? (
      <span className="whitespace-nowrap">{i.full_name}{i.department && <span className="block text-xs text-muted">{i.department}</span>}</span>
    ) : i.trainee ? (
      <span className="whitespace-nowrap">{i.trainee.full_name}<span className="block text-xs text-muted">{i.trainee.trainee_code}</span></span>
    ) : <span className="text-muted">—</span> },
    { key: "role", header: "Role", cell: (i) => <StatusBadge kind="role" value={i.role} /> },
    { key: "status", header: "Status", cell: (i) => <StatusBadge kind="invitation" value={i.status} /> },
    { key: "delivery", header: "Email delivery", cell: (i) => <DeliveryBadge value={i.email_delivery} /> },
    { key: "by", header: "Invited by", cell: (i) => <span className="whitespace-nowrap">{i.invited_by.full_name}</span> },
    { key: "created", header: "Sent", cell: (i) => <span className="whitespace-nowrap text-muted"><DateTime value={i.created_at} /></span> },
    { key: "expires", header: "Expires", cell: (i) => <span className="whitespace-nowrap text-muted"><DateTime value={i.expires_at} /></span> },
    { key: "done", header: "Accepted / revoked", cell: (i) => <span className="whitespace-nowrap text-muted">{i.accepted_at ? <DateTime value={i.accepted_at} /> : i.revoked_at ? <DateTime value={i.revoked_at} /> : "—"}</span> },
    { key: "actions", header: <span className="sr-only">Actions</span>, className: "text-right", cell: (i) => (
      <Button size="sm" variant="secondary" icon={<XCircle />} disabled={i.status !== "pending"} title={i.status !== "pending" ? "Only pending invitations can be revoked" : undefined}
        onClick={() => { revoke.reset(); setRevoking(i); }}>Revoke</Button>
    ) },
  ];

  return (
    <>
      <TableCard
        title="Invitations" icon={<EnvelopeSimple />}
        description="Invite links are shown only once, when created. A lost link means revoke and invite again."
        toolbar={<FilterBar>
          <LabeledSelect id="inv-status" label="Status" value={status} onChange={reset(setStatus)}>
            <option value="">Any</option><option value="pending">Pending</option><option value="accepted">Accepted</option>
            <option value="revoked">Revoked</option><option value="expired">Expired</option>
          </LabeledSelect>
          <LabeledSelect id="inv-role" label="Role" value={role} onChange={reset(setRole)}>
            <option value="">All staff</option><option value="admin">Admin</option><option value="supervisor">Supervisor</option>
          </LabeledSelect>
        </FilterBar>}
        footer={list.data?.data.length ? <Pagination meta={list.data.meta} onPageChange={setPage} /> : undefined}>
        {list.isLoading ? <CardState><LoadingState /></CardState> : list.error ? <CardState><ErrorState error={list.error} onRetry={() => list.refetch()} /></CardState> :
          !list.data?.data.length ? <CardState><EmptyState icon={<EnvelopeSimple />} title={status || role ? "No invitations match these filters" : "No invitations yet"} /></CardState> : (
            <DataTable rows={list.data.data} columns={cols} rowKey={(i) => i.id} caption="Invitations" />
          )}
      </TableCard>
      <ConfirmDialog open={!!revoking} title="Revoke invitation?" danger confirmLabel="Revoke" loading={revoke.isPending}
        message={<div className="flex flex-col gap-2"><p>The link sent to {revoking?.email} will stop working.</p><ApiErrorAlert error={revoke.error} /></div>}
        onClose={() => setRevoking(null)} onConfirm={() => revoking && revoke.mutate(revoking.id)} />
    </>
  );
}

// ---------------------------------------------------------------- invite staff

const inviteSchema = z.object({
  email: z.string().trim().email("Enter a valid email").max(254),
  role: z.enum(["supervisor", "admin"]),
  full_name: z.string().trim().max(120, "120 characters at most"),
  department: z.string().trim().max(120, "120 characters at most"),
});
type InviteForm = z.infer<typeof inviteSchema>;
const INVITE_DEFAULTS: InviteForm = { email: "", role: "supervisor", full_name: "", department: "" };

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [created, setCreated] = useState<{ url: string; delivery: string | null } | null>(null);
  const [alertError, setAlertError] = useState<unknown>(null);
  const form = useForm<InviteForm>({ resolver: zodResolver(inviteSchema), defaultValues: INVITE_DEFAULTS });
  const m = useMutation({
    onMutate: () => setAlertError(null),
    mutationFn: (v: InviteForm) => call(api.POST("/api/v1/admin/invitations", { body: {
      email: v.email.trim(), role: v.role, full_name: v.full_name.trim() || null, department: v.department.trim() || null, send_email: true,
    } })),
    onSuccess: (res) => {
      setCreated({ url: res.data.invite_url, delivery: res.data.invitation.email_delivery });
      invalidate(qk.invitations.all(), qk.reports.all());
      toast.success("Invitation created");
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === "EMAIL_IN_USE") {
        form.setError("email", { message: "An account with this email already exists" });
        return;
      }
      if (!applyFieldErrors(e, form.setError, ["email", "role", "full_name", "department"])) setAlertError(e);
    },
  });
  const close = () => {
    setCreated(null);
    setAlertError(null);
    form.reset(INVITE_DEFAULTS);
    m.reset();
    onClose();
  };
  const err = form.formState.errors;
  return (
    <Dialog open={open} onClose={close} title="Invite staff" description="Creates a one-time sign-up link valid for 7 days. Staff can only join this way."
      footer={created ? <Button onClick={close}>Done</Button> : <>
        <Button variant="secondary" onClick={close}>Cancel</Button>
        <Button type="submit" form="invite-staff" loading={m.isPending}>Create invitation</Button>
      </>}>
      {created ? (
        <div className="flex flex-col gap-3">
          <InviteUrlReveal url={created.url} onCopied={() => toast.success("Copied")} />
          {created.delivery === "queued" || created.delivery === "sent" ? (
            <Alert variant="info" icon={<EnvelopeSimple />}>The link is also being emailed to the person.</Alert>
          ) : created.delivery === "failed" ? (
            <Alert variant="warning" icon={<Warning />}>The email could not be sent. Share this link with the person yourself.</Alert>
          ) : (
            <Alert variant="warning" icon={<Warning />}>Email is not configured, so no email is sent. Share this link with the person yourself.</Alert>
          )}
        </div>
      ) : (
        <form id="invite-staff" noValidate className="flex flex-col gap-3" onSubmit={form.handleSubmit((v) => m.mutate(v))}>
          <ApiErrorAlert error={alertError} />
          <FormField label="Email" htmlFor="inv-email" required error={err.email?.message}>
            <Input id="inv-email" type="email" autoComplete="off" {...form.register("email")} />
          </FormField>
          <FormField label="Role" htmlFor="inv-role-select" required error={err.role?.message}>
            <Select id="inv-role-select" {...form.register("role")}>
              <option value="supervisor">Supervisor</option>
              <option value="admin">Admin</option>
            </Select>
          </FormField>
          <FormField label="Full name" htmlFor="inv-name" error={err.full_name?.message}>
            <Input id="inv-name" autoComplete="off" maxLength={120} {...form.register("full_name")} />
          </FormField>
          <FormField label="Department" htmlFor="inv-dept" error={err.department?.message} hint="Optional. Used to match supervisors to projects.">
            <Input id="inv-dept" autoComplete="off" maxLength={120} {...form.register("department")} />
          </FormField>
        </form>
      )}
    </Dialog>
  );
}

// ---------------------------------------------------------------- staff spreadsheet import

type StaffRow = StaffImportResult["results"][number];

const ROW_STATUS: Record<StaffRow["status"], [string, string]> = {
  invite: ["Invite", "border-success/20 bg-success-bg text-success"],
  skipped: ["Skipped", "border-border bg-neutral-bg text-neutral"],
  error: ["Error", "border-danger/20 bg-danger-bg text-danger"],
};

function StaffImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [file, setFile] = useState<File | null>(null);
  const [inputKey, setInputKey] = useState(0);
  const [preview, setPreview] = useState<StaffImportResult | null>(null);
  const [applied, setApplied] = useState<StaffImportResult | null>(null);
  const [fileError, setFileError] = useState<string>();
  const send = (dryRun: boolean) => {
    const form = new FormData();
    form.append("file", file as File);
    form.append("dry_run", dryRun ? "true" : "false");
    return uploadMultipart<{ data: StaffImportResult }>("/admin/imports/staff", form);
  };
  const fileErr = (e: unknown) => {
    if (e instanceof ApiError && e.code === "FILE_TOO_LARGE") setFileError("The file must be 5 MB or smaller");
    else if (e instanceof ApiError && e.code === "UNSUPPORTED_FILE_TYPE") setFileError("Upload an .xlsx or .csv file");
  };
  const dry = useMutation({
    mutationFn: () => send(true),
    onMutate: () => { setPreview(null); setApplied(null); setFileError(undefined); },
    onSuccess: (res) => setPreview(res.data),
    onError: fileErr,
  });
  const apply = useMutation({
    mutationFn: () => send(false),
    onSuccess: (res) => {
      setApplied(res.data);
      setPreview(null);
      invalidate(qk.invitations.all(), qk.users.all(), qk.reports.all());
      toast.success(`${res.data.invited} invitation${res.data.invited === 1 ? "" : "s"} created`);
    },
    onError: fileErr,
  });
  const close = () => {
    setFile(null);
    setPreview(null);
    setApplied(null);
    setFileError(undefined);
    setInputKey((k) => k + 1);
    dry.reset();
    apply.reset();
    onClose();
  };
  const busy = dry.isPending || apply.isPending;
  const shown = applied ?? preview;
  const otherError = [dry.error, apply.error].find(
    (e) => e && !(e instanceof ApiError && ["FILE_TOO_LARGE", "UNSUPPORTED_FILE_TYPE"].includes(e.code)),
  );
  const cols: Column<StaffRow>[] = [
    { key: "row", header: "Row", className: "w-16 font-semibold tabular-nums", cell: (r) => r.row },
    { key: "email", header: "Email", cell: (r) => <span className="break-all">{r.email ?? "—"}</span> },
    { key: "role", header: "Role", cell: (r) => (r.role ? <span className="capitalize">{r.role}</span> : "—") },
    { key: "status", header: "Result", cell: (r) => (
      <span className={cx("inline-flex rounded-full border px-2.5 py-0.5 text-xs font-semibold", ROW_STATUS[r.status][1])}>{ROW_STATUS[r.status][0]}</span>
    ) },
    { key: "msg", header: "Details", cell: (r) => <span className={r.status === "error" ? "text-danger" : "text-muted"}>{r.message}</span> },
  ];
  return (
    <Dialog open={open} onClose={busy ? () => {} : close} title="Import staff" size="lg"
      description="Invite several supervisors and admins from a spreadsheet. Preview first; nothing is sent until you confirm."
      footer={<>
        <Button variant="secondary" onClick={close} disabled={busy}>{applied ? "Done" : "Cancel"}</Button>
        {!applied && (
          <Button loading={apply.isPending} disabled={!preview || preview.invited === 0 || busy} icon={<EnvelopeSimple />} onClick={() => apply.mutate()}>
            Send invitations{preview ? ` (${preview.invited})` : ""}
          </Button>
        )}
      </>}>
      <div className="flex flex-col gap-4 text-sm">
        <Alert variant="info" icon={<FileXls />}>
          Columns: <strong>Email</strong>, <strong>Full Name</strong>, <strong>Role</strong> (Supervisor or Admin) and <strong>Department</strong> (optional).
          The sheet named "Staff" is used, otherwise the first sheet.
        </Alert>
        <FormField label="Spreadsheet (.xlsx or .csv, max 5 MB)" htmlFor="staff-file">
          <FileField key={inputKey} id="staff-file" accept=".xlsx,.csv" maxBytes={5 * 1024 * 1024} error={fileError}
            onChange={(f) => { setFile(f); setPreview(null); setApplied(null); setFileError(undefined); }} />
        </FormField>
        {!applied && (
          <div className="flex justify-end">
            <Button variant={preview ? "secondary" : "primary"} disabled={!file || busy} loading={dry.isPending} onClick={() => dry.mutate()}>
              {preview ? "Re-run preview" : "Preview"}
            </Button>
          </div>
        )}
        <ApiErrorAlert error={otherError} />
        {shown && (
          <section aria-label={applied ? "Import result" : "Preview"} className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {([["Rows", shown.rows], [applied ? "Invited" : "To invite", shown.invited], ["Skipped", shown.skipped], ["Errors", shown.errors]] as const).map(([k, n]) => (
                <div key={k} className="rounded-lg border border-border bg-surface-2 px-3 py-2.5">
                  <dt className="text-xs font-medium text-muted">{k}</dt>
                  <dd className="font-heading text-xl font-semibold tabular-nums">{n}</dd>
                </div>
              ))}
            </dl>
            {shown.email_backend === "disabled" ? (
              <Alert variant="warning" icon={<Warning />}>
                Email is not configured, so invitation emails are queued in-app only. Invite links must be shared manually
                (revoke and invite again from this page to get a link you can copy).
              </Alert>
            ) : (
              <p className="text-muted">Invitation emails go through the configured email service ({shown.email_backend}).</p>
            )}
            {!applied && <p className="text-muted">Preview only: nothing has been sent yet. Rows marked Skipped or Error are not invited.</p>}
            {shown.results.length > 0 && (
              <div className="max-h-80 overflow-y-auto rounded-xl">
                <DataTable rows={shown.results} columns={cols} rowKey={(r) => `${r.row}-${r.email ?? ""}`} caption="Staff import rows" />
              </div>
            )}
          </section>
        )}
      </div>
    </Dialog>
  );
}
