import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { z } from "zod";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { HOME } from "@/app/nav";
import { useAuth } from "@/auth/AuthProvider";
import { INVITE_KEY, supabase } from "@/auth/supabase";
import { FormError, FormField, LoadingState, PageHeader, useToast } from "@/components/shared";
import { Alert, Button, Card, Input } from "@/components/ui";
import { useQueryClient } from "@tanstack/react-query";

function PublicFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <header className="flex h-14 items-center border-b border-border bg-surface px-4">
        <Link to="/" className="font-semibold">Smart Project Allocation</Link>
        <nav className="ml-auto flex gap-3 text-sm">
          <Link to="/login" className="text-primary">Log in</Link>
          <Link to="/register" className="text-primary">Register</Link>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-[1100px] p-4 md:p-8">{children}</main>
    </div>
  );
}

export function Landing() {
  const { user } = useAuth();
  if (user) return <Navigate to={HOME[user.role]} replace />;
  return (
    <PublicFrame>
      <section className="py-8 md:py-14">
        <p className="text-sm font-medium text-primary">Tata STRIVE · ITI trainee projects</p>
        <h1 className="mt-2 max-w-3xl text-3xl font-semibold md:text-4xl">Match every trainee to the right project, and track it to a graded outcome.</h1>
        <p className="mt-4 max-w-2xl text-muted">
          The programme team imports trainee and project data. Explainable recommendations score each trainee against each project,
          the team reviews and publishes allocations, trainees submit their work, and supervisors evaluate it against the official rubric.
        </p>
        <div className="mt-6 flex gap-3">
          <Link to="/login"><Button>Log in</Button></Link>
          <Link to="/register"><Button variant="secondary">Register with an invite</Button></Link>
        </div>
      </section>
      <section className="grid gap-4 md:grid-cols-3">
        {[
          ["Explainable matching", "Each match score is the sum of five itemised factors: trade, practical readiness, skill coverage, interest alignment and theory/safety readiness. Gender is never used."],
          ["Human decision", "Auto-allocation creates a draft that maximises placements within capacity. The programme team edits, overrides with a reason, and publishes."],
          ["Rubric evaluation", "Supervisors score workmanship, demo, safety, documentation and viva. The total and grade are computed on the server, with a rework loop."],
        ].map(([t, d]) => (
          <Card key={t}><h2 className="font-semibold">{t}</h2><p className="mt-1 text-sm text-muted">{d}</p></Card>
        ))}
      </section>
    </PublicFrame>
  );
}

const loginSchema = z.object({ email: z.string().email("Enter a valid email"), password: z.string().min(1, "Enter your password") });

export function Login() {
  const { state } = useAuth();
  const [params] = useSearchParams();
  const [error, setError] = useState<string>();
  const form = useForm<z.infer<typeof loginSchema>>({ resolver: zodResolver(loginSchema) });
  if (state.status === "ready") return <Navigate to={HOME[state.user.role]} replace />;
  const reason = params.get("reason");
  const notice = state.status === "signedOut" ? state.notice : undefined;

  const onSubmit = form.handleSubmit(async ({ email, password }) => {
    setError(undefined);
    const { error: e } = await supabase.auth.signInWithPassword({ email, password });
    if (e) setError(e.message === "Email not confirmed" ? "Please confirm your email address before logging in." : "Email or password is incorrect.");
  });

  return (
    <PublicFrame>
      <div className="mx-auto max-w-md">
        <PageHeader title="Log in" />
        <Card>
          <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
            {(notice || reason === "expired") && <Alert variant="warning">{notice ?? "Your session expired. Please log in again."}</Alert>}
            {reason === "disabled" && !notice && <Alert variant="danger">Your account has been disabled. Contact your coordinator.</Alert>}
            {state.status === "error" && <Alert variant="danger">{state.message}</Alert>}
            {error && <Alert variant="danger">{error}</Alert>}
            <FormField label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
              <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
            </FormField>
            <FormField label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
              <Input id="password" type="password" autoComplete="current-password" {...form.register("password")} />
            </FormField>
            <Button type="submit" loading={form.formState.isSubmitting || state.status === "provisioning" || state.status === "loading"}>Log in</Button>
            <p className="text-sm text-muted">New here? <Link className="text-primary" to="/register">Register</Link></p>
          </form>
        </Card>
      </div>
    </PublicFrame>
  );
}

const registerSchema = z.object({
  full_name: z.string().trim().min(1, "Enter your name").max(120),
  email: z.string().email("Enter a valid email"),
  password: z.string().min(8, "At least 8 characters"),
});

export function Register() {
  const { state } = useAuth();
  const [params] = useSearchParams();
  const invite = params.get("invite");
  const [error, setError] = useState<string>();
  const [checkEmail, setCheckEmail] = useState(false);
  const form = useForm<z.infer<typeof registerSchema>>({ resolver: zodResolver(registerSchema) });

  useEffect(() => {
    if (invite) {
      try {
        sessionStorage.setItem(INVITE_KEY, invite);
      } catch {
        /* storage unavailable: provisioning falls back to a plain student account */
      }
    }
  }, [invite]);

  if (state.status === "ready") return <Navigate to={HOME[state.user.role]} replace />;

  const onSubmit = form.handleSubmit(async ({ full_name, email, password }) => {
    setError(undefined);
    const { data, error: e } = await supabase.auth.signUp({ email, password, options: { data: { full_name } } });
    if (e) {
      setError(e.message.includes("registered") ? "An account with this email already exists. Log in instead." : e.message);
      return;
    }
    if (!data.session) setCheckEmail(true); // email confirmation is enabled on the project
  });

  return (
    <PublicFrame>
      <div className="mx-auto max-w-md">
        <PageHeader title={invite ? "Accept your invitation" : "Create a student account"}
          description={invite ? "Use the email address your coordinator invited." : "Accounts created here are student accounts. Staff join by invitation."} />
        <Card>
          {checkEmail ? (
            <Alert variant="info" title="Check your email">Confirm your address using the link we sent, then log in.</Alert>
          ) : (
            <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
              {state.status === "signedOut" && state.notice && <Alert variant="warning">{state.notice}</Alert>}
              {error && <Alert variant="danger">{error}</Alert>}
              <FormField label="Full name" htmlFor="full_name" error={form.formState.errors.full_name?.message}>
                <Input id="full_name" autoComplete="name" {...form.register("full_name")} />
              </FormField>
              <FormField label="Email" htmlFor="remail" error={form.formState.errors.email?.message}>
                <Input id="remail" type="email" autoComplete="email" {...form.register("email")} />
              </FormField>
              <FormField label="Password" htmlFor="rpassword" error={form.formState.errors.password?.message} hint="At least 8 characters">
                <Input id="rpassword" type="password" autoComplete="new-password" {...form.register("password")} />
              </FormField>
              <Button type="submit" loading={form.formState.isSubmitting || state.status === "provisioning"}>Create account</Button>
              <p className="text-sm text-muted">Already registered? <Link className="text-primary" to="/login">Log in</Link></p>
            </form>
          )}
        </Card>
      </div>
    </PublicFrame>
  );
}

const accountSchema = z.object({ full_name: z.string().trim().min(1).max(120), department: z.string().max(120).optional() });

export function Account() {
  const { user, refreshUser } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const form = useForm<z.infer<typeof accountSchema>>({
    resolver: zodResolver(accountSchema),
    values: { full_name: user?.full_name ?? "", department: user?.department ?? "" },
  });
  const m = useMutation({
    mutationFn: (v: z.infer<typeof accountSchema>) => call(api.PATCH("/api/v1/me", { body: { full_name: v.full_name, department: v.department || null } })),
    onSuccess: async () => {
      toast.success("Account saved");
      await qc.invalidateQueries({ queryKey: qk.me() });
      await refreshUser();
    },
  });
  if (!user) return <LoadingState />;
  return (
    <div className="max-w-lg">
      <PageHeader title="My account" description={`${user.email} · ${user.role}`} />
      <Card>
        <form className="flex flex-col gap-4" onSubmit={form.handleSubmit((v) => m.mutate(v))}>
          <FormError error={m.error} />
          <FormField label="Full name" htmlFor="acc_name" error={form.formState.errors.full_name?.message}>
            <Input id="acc_name" {...form.register("full_name")} />
          </FormField>
          <FormField label="Department" htmlFor="acc_dept">
            <Input id="acc_dept" {...form.register("department")} />
          </FormField>
          <Button type="submit" loading={m.isPending}>Save</Button>
        </form>
      </Card>
    </div>
  );
}
