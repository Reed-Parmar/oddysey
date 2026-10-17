import { zodResolver } from "@hookform/resolvers/zod";
import {
  ArrowRight,
  ChalkboardTeacher,
  CheckCircle,
  ClipboardText,
  Eye,
  EyeSlash,
  FileMagnifyingGlass,
  FlagCheckered,
  GraduationCap,
  IdentificationCard,
  type Icon,
  Robot,
  ShieldCheck,
  Sparkle,
  Target,
  UserGear,
  UserPlus,
  UploadSimple,
} from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { forwardRef, useEffect, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { useForm } from "react-hook-form";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { z } from "zod";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { BrandMark } from "@/app/AppShell";
import { HOME, ROLE_LABEL } from "@/app/nav";
import { useAuth } from "@/auth/AuthProvider";
import { INVITE_KEY, supabase } from "@/auth/supabase";
import { Avatar, FormError, FormField, LoadingState, PageHeader, useToast } from "@/components/shared";
import { Alert, Button, Card, Input, buttonStyles } from "@/components/ui";

function PublicHeader() {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-surface/90 backdrop-blur-md">
      <div className="mx-auto flex h-16 w-full max-w-6xl items-center gap-3 px-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5 rounded-lg">
          <BrandMark />
          <span className="font-heading text-[0.95rem] font-semibold text-text">Smart Project Allocation</span>
        </Link>
        <nav aria-label="Account" className="ml-auto flex items-center gap-1 sm:gap-2">
          <Link to="/login" className={buttonStyles("ghost", "sm")}>Log in</Link>
          <Link to="/register" className={buttonStyles("primary", "sm")}>Register</Link>
        </nav>
      </div>
    </header>
  );
}

function PublicFrame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh">
      <PublicHeader />
      <main className="mx-auto w-full max-w-6xl px-4 sm:px-6">{children}</main>
    </div>
  );
}

/** The automated lifecycle, as labels only (the live version is on each role's dashboard). */
const STAGES: [Icon, string, string][] = [
  [UserPlus, "Trainee Onboarding", "Imported by the programme team or self-registered"],
  [IdentificationCard, "Profile Verification", "Skills, interests and verified practical marks"],
  [FileMagnifyingGlass, "Project Analysis", "Project documents processed in the background"],
  [Sparkle, "AI-Assisted Matching", "Itemised rule scores; gender is never used"],
  [Target, "Automated Allocation", "Every 15 minutes, one project per trainee"],
  [UploadSimple, "Student Submission", "A written report, with a rework loop"],
  [ClipboardText, "Evaluation", "Automated rubric and originality analysis, reviewed by supervisors"],
  [FlagCheckered, "Completion", "Outcomes frozen when the cycle is archived"],
];

/** Split layout for log-in and registration: brand panel on large screens, form always first on mobile. */
function AuthLayout({ title, description, children, footer }: { title: string; description?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)]">
      <aside className="relative hidden overflow-hidden bg-chrome text-white lg:flex lg:flex-col lg:justify-between lg:gap-10 lg:p-12">
        <Link to="/" className="relative flex items-center gap-3 rounded-lg">
          <BrandMark className="size-9" />
          <span className="font-heading text-lg font-semibold">Smart Project Allocation</span>
        </Link>
        <div className="relative max-w-md">
          <p className="text-sm font-semibold tracking-wide text-chrome-muted uppercase">Tata STRIVE · ITI trainee projects</p>
          <p className="mt-3 font-heading text-3xl leading-tight font-semibold">The right project for every trainee, tracked to a graded outcome.</p>
          <ol aria-label="How it works" className="mt-8">
            {STAGES.map(([I, t, d], i) => (
              <li key={t} className="relative flex gap-3 pb-4 last:pb-0">
                {i < STAGES.length - 1 && <span aria-hidden className="absolute top-9 bottom-0 left-[17px] w-0.5 bg-white/15" />}
                <span aria-hidden className="relative inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/15 bg-chrome-2 text-chrome-accent">
                  <I size={18} />
                </span>
                <div className="min-w-0 pt-0.5">
                  <p className="text-sm font-semibold">{t}</p>
                  <p className="text-xs text-chrome-text">{d}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
        <p className="relative text-xs text-chrome-muted">Security is enforced on the server. Your data is only visible to your programme team.</p>
      </aside>

      <div className="flex min-h-dvh flex-col">
        <div className="flex h-16 items-center px-4 sm:px-6 lg:hidden">
          <Link to="/" className="flex items-center gap-2.5 rounded-lg">
            <BrandMark />
            <span className="font-heading text-[0.95rem] font-semibold">Smart Project Allocation</span>
          </Link>
        </div>
        <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
          <div className="w-full max-w-sm">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {description && <p className="mt-1.5 text-sm text-muted">{description}</p>}
            <div className="mt-6">{children}</div>
            {footer && <div className="mt-6 text-center text-sm text-muted">{footer}</div>}
          </div>
        </main>
      </div>
    </div>
  );
}

const PasswordInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function PasswordInput(props, ref) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input ref={ref} type={show ? "text" : "password"} className="pr-11" {...props} />
      <button
        type="button"
        onClick={() => setShow((s) => !s)}
        aria-label={show ? "Hide password" : "Show password"}
        aria-pressed={show}
        className="absolute inset-y-0 right-0 inline-flex w-11 items-center justify-center rounded-r-lg text-muted hover:text-text"
      >
        {show ? <EyeSlash aria-hidden size={18} /> : <Eye aria-hidden size={18} />}
      </button>
    </div>
  );
});

const ROLES: [Icon, string, string][] = [
  [GraduationCap, "Trainees", "Receive a project with the reasons it was chosen, reject it once if it does not fit, and submit your report in versions."],
  [ChalkboardTeacher, "Supervisors", "Review the automated evaluation and originality analysis, then finalise or request rework."],
  [UserGear, "Programme team", "Import trainees and projects, watch the automated lifecycle, and step in only where a stage needs attention."],
];

const HIGHLIGHTS: [Icon, string, string][] = [
  [Sparkle, "Explainable matching", "Every score is the sum of itemised factors (trade, practical readiness, skill coverage, interests). Gender is never used."],
  [Robot, "Automated, not opaque", "A background worker processes projects, allocates every 15 minutes and analyses reports. Each stage shows its status and errors."],
  [ClipboardText, "Evaluation with evidence", "Each report gets an automated rubric evaluation and a Plagiarism & Originality Analysis that supervisors review."],
];

export function Landing() {
  const { user } = useAuth();
  if (user) return <Navigate to={HOME[user.role]} replace />;
  return (
    <PublicFrame>
      <section className="grid items-center gap-10 py-12 md:py-20 lg:grid-cols-[1.15fr_1fr]">
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary-soft px-3 py-1 text-sm font-semibold text-primary-ink">
            <Sparkle aria-hidden size={14} weight="fill" /> Tata STRIVE · ITI trainee projects
          </p>
          <h1 className="mt-5 text-4xl leading-[1.1] font-semibold tracking-tight md:text-5xl">
            Match every trainee to the right project, and track it to a graded outcome.
          </h1>
          <p className="mt-5 max-w-xl text-lg text-muted">
            Automated, explainable allocation, versioned report submissions and evidence-based evaluation, in one place for trainees, supervisors and the programme team.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to="/login" className={buttonStyles("primary", "lg")}>
              Log in <ArrowRight aria-hidden size={18} />
            </Link>
            <Link to="/register" className={buttonStyles("secondary", "lg")}>Register as a trainee</Link>
          </div>
        </div>
        <div className="rounded-2xl border border-border bg-dot-grid p-4 shadow-card sm:p-6">
          <ol aria-label="How it works" className="grid gap-2.5 sm:grid-cols-2">
            {STAGES.map(([I, t], i) => (
              <li key={t} className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3.5 py-3 shadow-card">
                <span aria-hidden className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary">
                  <I size={18} />
                </span>
                <span className="min-w-0 flex-1 text-sm font-semibold">{t}</span>
                <span aria-hidden className="font-mono text-[0.68rem] text-subtle">{String(i + 1).padStart(2, "0")}</span>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section aria-labelledby="features" className="pb-12">
        <h2 id="features" className="sr-only">Features</h2>
        <div className="grid gap-4 md:grid-cols-3">
          {HIGHLIGHTS.map(([I, t, d]) => (
            <Card key={t} icon={<I />} title={t}>
              <p className="text-sm leading-relaxed text-muted">{d}</p>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="roles" className="border-t border-border py-12">
        <h2 id="roles" className="text-xl font-semibold">Built for three roles</h2>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {ROLES.map(([I, t, d]) => (
            <div key={t} className="flex gap-3">
              <I aria-hidden size={24} className="mt-0.5 shrink-0 text-primary" />
              <div>
                <p className="font-semibold">{t}</p>
                <p className="mt-1 text-sm text-muted">{d}</p>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-8 flex items-center gap-2 text-sm text-muted">
          <ShieldCheck aria-hidden size={18} className="text-success" />
          Every permission is enforced on the server; gender and personal details are never sent to the AI.
        </p>
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
    <AuthLayout
      title="Welcome back"
      description="Log in to see your projects, submissions and evaluations."
      footer={<>New here? <Link className="font-semibold text-primary hover:underline" to="/register">Create a trainee account</Link></>}
    >
      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        {(notice || reason === "expired") && <Alert variant="warning">{notice ?? "Your session expired. Please log in again."}</Alert>}
        {reason === "disabled" && !notice && <Alert variant="danger">Your account has been disabled. Contact your coordinator.</Alert>}
        {state.status === "error" && <Alert variant="danger">{state.message}</Alert>}
        {error && <Alert variant="danger">{error}</Alert>}
        <FormField label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" inputMode="email" aria-invalid={!!form.formState.errors.email} {...form.register("email")} />
        </FormField>
        <FormField label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
          <PasswordInput id="password" autoComplete="current-password" aria-invalid={!!form.formState.errors.password} {...form.register("password")} />
        </FormField>
        <Button type="submit" size="lg" className="mt-1 w-full" loading={form.formState.isSubmitting || state.status === "provisioning" || state.status === "loading"}>
          Log in
        </Button>
      </form>
    </AuthLayout>
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
    <AuthLayout
      title={invite ? "Accept your invitation" : "Create a trainee account"}
      description={invite ? "Use the email address your coordinator invited." : "Accounts created here are trainee accounts. Staff join by invitation."}
      footer={<>Already registered? <Link className="font-semibold text-primary hover:underline" to="/login">Log in</Link></>}
    >
      {checkEmail ? (
        <Alert variant="success" icon={<CheckCircle weight="fill" />} title="Check your email">
          Confirm your address using the link we sent, then log in.
        </Alert>
      ) : (
        <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          {invite && <Alert variant="info" icon={<ShieldCheck />}>Your invitation will be applied when you first log in.</Alert>}
          {state.status === "signedOut" && state.notice && <Alert variant="warning">{state.notice}</Alert>}
          {error && <Alert variant="danger">{error}</Alert>}
          <FormField label="Full name" htmlFor="full_name" error={form.formState.errors.full_name?.message} required>
            <Input id="full_name" autoComplete="name" aria-invalid={!!form.formState.errors.full_name} {...form.register("full_name")} />
          </FormField>
          <FormField label="Email" htmlFor="remail" error={form.formState.errors.email?.message} required>
            <Input id="remail" type="email" autoComplete="email" inputMode="email" aria-invalid={!!form.formState.errors.email} {...form.register("email")} />
          </FormField>
          <FormField label="Password" htmlFor="rpassword" error={form.formState.errors.password?.message} hint="At least 8 characters" required>
            <PasswordInput id="rpassword" autoComplete="new-password" aria-invalid={!!form.formState.errors.password} {...form.register("password")} />
          </FormField>
          <Button type="submit" size="lg" className="mt-1 w-full" loading={form.formState.isSubmitting || state.status === "provisioning"}>
            Create account
          </Button>
        </form>
      )}
    </AuthLayout>
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
    <div className="max-w-2xl">
      <PageHeader title="My account" description="Your name is shown to supervisors and the programme team." />
      <div className="space-y-6">
        <Card>
          <div className="flex items-center gap-4">
            <Avatar name={user.full_name} />
            <div className="min-w-0">
              <p className="truncate font-semibold">{user.full_name}</p>
              <p className="truncate text-sm text-muted">{user.email} · {ROLE_LABEL[user.role]}</p>
            </div>
          </div>
        </Card>
        <Card title="Profile details">
          <form className="flex flex-col gap-4" onSubmit={form.handleSubmit((v) => m.mutate(v))}>
            <FormError error={m.error} />
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Full name" htmlFor="acc_name" error={form.formState.errors.full_name?.message} required>
                <Input id="acc_name" autoComplete="name" {...form.register("full_name")} />
              </FormField>
              <FormField label="Department" htmlFor="acc_dept" hint="Optional">
                <Input id="acc_dept" {...form.register("department")} />
              </FormField>
            </div>
            <div className="flex justify-end">
              <Button type="submit" loading={m.isPending}>Save changes</Button>
            </div>
          </form>
        </Card>
      </div>
    </div>
  );
}
