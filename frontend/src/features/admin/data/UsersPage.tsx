/** /admin/users (USR-01/02, INV-01..03; admin.md §3.10). */
import { zodResolver } from "@hookform/resolvers/zod";
import { EnvelopeSimple, Prohibit, UserCheck, UserGear, UserPlus, Users, Warning, XCircle } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { api, call } from "@/api/client";
import { ApiError } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { AdminUser, Invitation, UserRole } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import {
  Avatar, ConfirmDialog, DataTable, DateTime, EmptyState, ErrorState, FormField, LoadingState, PageHeader, Pagination,
  StatusBadge, useToast, type Column,
} from "@/components/shared";
import { Alert, Button, Dialog, Input, Select, cx } from "@/components/ui";

import {
  ApiErrorAlert, CardState, FilterBar, InviteUrlReveal, LabeledSelect, SearchInput, TableCard, TextLink, applyFieldErrors,
  useDebounced, useInvalidate,
} from "./common";

const ROLE_LABEL: Record<UserRole, string> = { student: "Student", supervisor: "Supervisor", admin: "Admin" };

export function UsersPage() {
  const [tab, setTab] = useState<"users" | "invitations">("users");
  const [inviteOpen, setInviteOpen] = useState(false);
  return (
    <div>
      <PageHeader title="Users & invites" description="Staff join by invitation only. Students register themselves or through a trainee-bound invite."
        actions={<Button icon={<UserPlus />} onClick={() => setInviteOpen(true)}>Invite user</Button>} />
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
    status: (status || undefined) as AdminUser["status"] | undefined, sort, page, page_size: 20,
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
    { key: "trainee", header: "Linked trainee", cell: (u) => u.trainee ? <TextLink to={`/admin/trainees/${u.trainee.id}`}>{u.trainee.trainee_code}</TextLink> : <span className="text-muted">—</span> },
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
          <option value="">All roles</option><option value="student">Student</option>
          <option value="supervisor">Supervisor</option><option value="admin">Admin</option>
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
      invalidate(qk.users.all(), qk.projects.all(), qk.reports.all());
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
  const supProjects = useQuery({
    queryKey: qk.projects.list({ supervisor_id: user.id, page_size: 100 }),
    queryFn: () => call(api.GET("/api/v1/projects", { params: { query: { supervisor_id: user.id, page_size: 100 } } })),
    enabled: disabling && user.role === "supervisor",
  });
  const activeProjects = (supProjects.data?.data ?? []).filter((p) => p.status !== "archived").length;
  const message = (
    <div className="flex flex-col gap-2">
      <p>{disabling ? `${user.full_name} will be signed out and unable to use the app until re-enabled.` : `${user.full_name} will be able to sign in again.`}</p>
      {disabling && user.role === "supervisor" && (supProjects.isLoading ? <p className="text-muted">Checking assigned projects…</p> :
        activeProjects > 0 && <Alert variant="warning" icon={<Warning />}>This supervisor has {activeProjects} active project{activeProjects === 1 ? "" : "s"}. Their trainees will have no evaluator until you reassign them.</Alert>)}
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
    sort: "-created_at" as const, page, page_size: 20,
  };
  const list = useQuery({
    queryKey: qk.invitations.list(query),
    queryFn: () => call(api.GET("/api/v1/admin/invitations", { params: { query } })),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => call(api.POST("/api/v1/admin/invitations/{invitation_id}/revoke", { params: { path: { invitation_id: id } } })),
    onSuccess: () => {
      invalidate(qk.invitations.all(), qk.trainees.all(), qk.reports.all());
      toast.success("Invitation revoked");
      setRevoking(null);
    },
  });
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(1); };

  const cols: Column<Invitation>[] = [
    { key: "email", header: "Email", cell: (i) => (
      <span className="flex min-w-48 items-center gap-2 font-medium break-all text-text"><EnvelopeSimple aria-hidden size={16} className="shrink-0 text-subtle" />{i.email}</span>
    ) },
    { key: "role", header: "Role", cell: (i) => <StatusBadge kind="role" value={i.role} /> },
    { key: "trainee", header: "Trainee", cell: (i) => i.trainee ? <TextLink to={`/admin/trainees/${i.trainee.id}`}>{i.trainee.trainee_code} · {i.trainee.full_name}</TextLink> : <span className="text-muted">—</span> },
    { key: "status", header: "Status", cell: (i) => <StatusBadge kind="invitation" value={i.status} /> },
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
          <option value="">All roles</option><option value="student">Student</option>
          <option value="supervisor">Supervisor</option><option value="admin">Admin</option>
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

// ---------------------------------------------------------------- invite (INV-02)

const inviteSchema = z.object({
  email: z.string().trim().email("Enter a valid email").max(254),
  role: z.enum(["supervisor", "admin", "student"]),
  trainee_id: z.string(),
}).refine((v) => v.role !== "student" || v.trainee_id !== "", { path: ["trainee_id"], message: "Choose the trainee this student account belongs to" });
type InviteForm = z.infer<typeof inviteSchema>;

function InviteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [url, setUrl] = useState<string | null>(null);
  const [alertError, setAlertError] = useState<unknown>(null);
  const [traineeQ, setTraineeQ] = useState("");
  const dq = useDebounced(traineeQ.trim());
  const form = useForm<InviteForm>({ resolver: zodResolver(inviteSchema), defaultValues: { email: "", role: "supervisor", trainee_id: "" } });
  const role = form.watch("role");
  const tParams = { linked: false, has_open_invitation: false, q: dq || undefined, sort: "full_name", page_size: 50 };
  const trainees = useQuery({
    queryKey: qk.trainees.list(tParams),
    queryFn: () => call(api.GET("/api/v1/trainees", { params: { query: tParams } })),
    enabled: open && role === "student",
  });
  const m = useMutation({
    onMutate: () => setAlertError(null),
    mutationFn: (v: InviteForm) => call(api.POST("/api/v1/admin/invitations", {
      body: v.role === "student" ? { email: v.email.trim(), role: v.role, trainee_id: v.trainee_id } : { email: v.email.trim(), role: v.role },
    })),
    onSuccess: (res) => {
      setUrl(res.data.invite_url);
      invalidate(qk.invitations.all(), qk.trainees.all(), qk.reports.all());
      toast.success("Invitation created");
    },
    onError: (e) => {
      if (!applyFieldErrors(e, form.setError, ["email", "role", "trainee_id"], { EMAIL_IN_USE: "email", ACCOUNT_ALREADY_LINKED: "trainee_id" })) setAlertError(e);
      if (e instanceof ApiError && e.code === "EMAIL_IN_USE") form.setError("email", { message: "An account with this email already exists" });
    },
  });
  const close = () => {
    setUrl(null); setAlertError(null); setTraineeQ("");
    form.reset({ email: "", role: "supervisor", trainee_id: "" });
    m.reset();
    onClose();
  };
  const err = form.formState.errors;
  return (
    <Dialog open={open} onClose={close} title="Invite user" description="Creates a one-time sign-up link valid for 7 days. Staff can only join this way." footer={url ? <Button onClick={close}>Done</Button> : <>
      <Button variant="secondary" onClick={close}>Cancel</Button>
      <Button type="submit" form="invite-user" loading={m.isPending}>Create invitation</Button>
    </>}>
      {url ? <InviteUrlReveal url={url} onCopied={() => toast.success("Copied")} /> : (
        <form id="invite-user" noValidate className="flex flex-col gap-3" onSubmit={form.handleSubmit((v) => m.mutate(v))}>
          <ApiErrorAlert error={alertError} />
          <FormField label="Email" htmlFor="inv-email" required error={err.email?.message}>
            <Input id="inv-email" type="email" autoComplete="off" {...form.register("email")} />
          </FormField>
          <FormField label="Role" htmlFor="inv-role-select" required error={err.role?.message}>
            <Select id="inv-role-select" {...form.register("role")}>
              <option value="supervisor">Supervisor</option>
              <option value="admin">Admin</option>
              <option value="student">Student (linked to a trainee record)</option>
            </Select>
          </FormField>
          {role === "student" && (
            <>
              <FormField label="Find trainee" htmlFor="inv-trainee-q" hint="Trainees in the active cycle without an account or open invitation.">
                <Input id="inv-trainee-q" type="search" maxLength={100} value={traineeQ} onChange={(e) => setTraineeQ(e.target.value)} placeholder="Name or code" />
              </FormField>
              <FormField label="Trainee" htmlFor="inv-trainee" required error={err.trainee_id?.message}>
                <Select id="inv-trainee" {...form.register("trainee_id")}>
                  <option value="">{trainees.isLoading ? "Loading…" : trainees.data?.data.length ? "Choose a trainee" : "No matching trainees"}</option>
                  {(trainees.data?.data ?? []).map((t) => <option key={t.id} value={t.id}>{t.trainee_code} · {t.full_name}</option>)}
                </Select>
              </FormField>
              {trainees.error != null && <ApiErrorAlert error={trainees.error} />}
            </>
          )}
        </form>
      )}
    </Dialog>
  );
}
