/**
 * ADR-019 "Needs attention" panel (ALR-01, every role) and ADR-020 Project Assistant (AST-01, students only: ADR-030).
 * ADR-022: the panel renders only when an urgent (critical/warning) alert exists; the assistant is a floating launcher,
 * mounted once in the student area layout (`StudentAssistant`) so it shows on every trainee page.
 */
import { PaperPlaneRight, Siren, X } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Link, Outlet } from "react-router-dom";

import { api, call } from "@/api/client";
import { errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { AssistantAnswer, AutopilotAlert } from "@/api/types";
import { useAuth } from "@/auth/AuthProvider";
import { Skeleton } from "@/components/shared";
import { Alert, Button, Card, Input, cx } from "@/components/ui";

const VARIANT = { critical: "danger", warning: "warning", info: "info" } as const;
const URGENT = new Set<AutopilotAlert["severity"]>(["critical", "warning"]);

/** Renders nothing unless something urgent needs the user (no "all clear" noise, no loading flash). */
export function AlertsPanel() {
  const q = useQuery({
    queryKey: qk.alerts.me(),
    queryFn: () => call(api.GET("/api/v1/me/alerts")),
    refetchInterval: 60_000,
  });
  const alerts = (q.data?.data ?? []).filter((a) => URGENT.has(a.severity));
  if (!alerts.length) return null;
  return (
    <Card title="Needs attention" icon={<Siren />} description="Raised automatically. Only what needs you is shown here.">
      <ul className="space-y-2">
        {alerts.map((a) => (
          <li key={a.code}>
            <Alert variant={VARIANT[a.severity]} title={a.title}>
              <span>{a.detail} </span>
              <Link to={a.link} className="font-semibold underline underline-offset-2">
                Open
              </Link>
            </Alert>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------- assistant

type Turn = {
  role: "user" | "assistant";
  content: string;
  sources?: string[];
  mode?: AssistantAnswer["mode"];
  intent?: string | null;
  /** Follow-up questions for this answer (AST-01 `suggestions`); shown only under the latest answer. */
  suggestions?: string[];
};

const SUGGESTIONS = ["Summarise my project", "When is the deadline?", "Why was this project allocated?", "What should I do next?"];
const SOURCE_LABEL: Record<string, string> = {
  project: "Project details",
  brief: "Project brief",
  guide: "Project guide",
  deadline: "Deadline",
  allocation: "Allocation explanation",
  submission: "Submission status",
  feedback: "Evaluation feedback",
};

/** Where an answer came from, in plain words. */
function answerNote(t: Turn) {
  if (t.sources?.length) return `From: ${t.sources.map((s) => SOURCE_LABEL[s] ?? s).join(", ")}${t.mode === "rules" ? " · quick answer" : ""}`;
  if (t.intent === "greeting") return "Project assistant";
  return t.mode === "rules" ? "Quick answer · the AI is busy right now" : "Project assistant";
}

/** Friendly robot mascot. `wave` animates the right arm (stops under reduced motion). */
export function RobotMascot({ className = "size-14", wave = true }: { className?: string; wave?: boolean }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={className}>
      {/* antenna */}
      <line x1="32" y1="9" x2="32" y2="15" stroke="var(--color-primary-ink)" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="32" cy="7.5" r="3.2" fill="var(--color-clay)" className="robot-blink" />
      {/* waving arm (behind body) */}
      <g className={wave ? "robot-wave" : undefined} style={{ transformOrigin: "50px 38px" }}>
        <path d="M50 38 L58 26" stroke="var(--color-primary)" strokeWidth="5" strokeLinecap="round" />
        <circle cx="58.5" cy="24.5" r="4" fill="var(--color-accent-light)" />
      </g>
      {/* left arm */}
      <path d="M14 38 L8 46" stroke="var(--color-primary)" strokeWidth="5" strokeLinecap="round" />
      {/* head */}
      <rect x="13" y="15" width="38" height="28" rx="11" fill="var(--color-primary)" />
      <rect x="13" y="15" width="38" height="14" rx="11" fill="white" fillOpacity="0.14" />
      {/* face screen */}
      <rect x="18" y="20" width="28" height="18" rx="8" fill="var(--color-chrome)" />
      <circle cx="26" cy="29" r="3" fill="var(--color-chrome-accent)" className="robot-eye" />
      <circle cx="38" cy="29" r="3" fill="var(--color-chrome-accent)" className="robot-eye" />
      <path d="M28 34 Q32 37 36 34" stroke="var(--color-chrome-accent)" strokeWidth="1.8" fill="none" strokeLinecap="round" />
      {/* cheeks */}
      <circle cx="21" cy="34" r="1.6" fill="var(--color-clay)" fillOpacity="0.8" />
      <circle cx="43" cy="34" r="1.6" fill="var(--color-clay)" fillOpacity="0.8" />
      {/* body */}
      <rect x="20" y="43" width="24" height="15" rx="6" fill="var(--color-primary-light)" />
      <circle cx="32" cy="50.5" r="3" fill="var(--color-accent-soft)" stroke="var(--color-accent)" strokeWidth="1.5" />
    </svg>
  );
}

const GREETED = "spa-assistant-greeted";
const TITLE = "Ask about my project";

/**
 * ADR-030: the student area layout. Renders the page, plus the floating assistant on every trainee page once the
 * trainee has an allocated project. UX only: AST-01 is student-only on the server too.
 */
export function StudentAssistant({ hasProject }: { hasProject: boolean }) {
  return (
    <>
      <Outlet />
      {hasProject && <AssistantLauncher />}
    </>
  );
}

/**
 * Floating assistant: a waving robot button at the bottom-right that opens the chat panel. Students only (ADR-030):
 * it renders nothing for any other role. It always asks about the student's own active allocation.
 * The panel is non-modal (the page stays usable); Escape or the close button dismisses it and focus returns to the button.
 */
export function AssistantLauncher() {
  const { user } = useAuth();
  if (user?.role !== "student") return null;
  return <Launcher title={TITLE} />;
}

function Launcher({ title }: { title: string }) {
  const [open, setOpen] = useState(false);
  const [greet, setGreet] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  // A one-time speech bubble per browser session so the robot introduces itself.
  useEffect(() => {
    let seen = true;
    try {
      seen = sessionStorage.getItem(GREETED) === "1";
      sessionStorage.setItem(GREETED, "1");
    } catch {
      seen = false;
    }
    if (seen) return;
    setGreet(true);
    const t = setTimeout(() => setGreet(false), 6000);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div className="fixed right-4 bottom-4 z-40 flex flex-col items-end gap-3 sm:right-6 sm:bottom-6">
      {open && (
        <AssistantChat
          id={panelId}
          title={title}
          onClose={() => {
            setOpen(false);
            buttonRef.current?.focus();
          }}
        />
      )}
      {!open && greet && (
        <p role="status" className="animate-slide-in rounded-2xl rounded-br-sm border border-border bg-surface-strong px-3.5 py-2 text-sm font-medium text-text shadow-raised">
          Hi! Ask me anything about your project.
        </p>
      )}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={open ? `Close ${title}` : title}
        onClick={() => {
          setGreet(false);
          setOpen((v) => !v);
        }}
        className={cx(
          "group relative grid size-16 place-items-center rounded-full border border-white/60 bg-surface-strong shadow-raised transition-transform duration-200",
          "hover:-translate-y-1 active:translate-y-0",
        )}
      >
        <span aria-hidden className="absolute inset-0 rounded-full bg-linear-to-br from-primary-soft via-transparent to-accent-soft" />
        {open ? <X aria-hidden size={24} className="relative text-text" /> : <RobotMascot className="relative size-14" />}
      </button>
    </div>
  );
}

function AssistantChat({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const titleId = `${id}-title`;
  const followupsId = `${id}-followups`;
  const latest = turns.at(-1);
  const ask = useMutation({
    // `history` is the conversation before this question (the question itself is sent once, as `question`).
    mutationFn: ({ q, history }: { q: string; history: Turn[] }) =>
      call(
        api.POST("/api/v1/assistant/ask", {
          body: {
            question: q,
            history: history.slice(-6).map(({ role, content }) => ({ role, content: content.slice(0, 1000) })),
          },
        }),
      ),
    onSuccess: (r) =>
      setTurns((t) => [
        ...t,
        { role: "assistant", content: r.answer, sources: r.sources, mode: r.mode, intent: r.intent, suggestions: r.suggestions ?? [] },
      ]),
  });

  // Effects must return nothing or a cleanup function, so these use block bodies.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [turns.length, ask.isPending]);

  function send(q: string) {
    const text = q.trim();
    if (text.length < 3 || ask.isPending) return;
    const history = turns;
    setTurns((t) => [...t, { role: "user", content: text.slice(0, 500) }]);
    setQuestion("");
    ask.mutate({ q: text.slice(0, 500), history });
  }
  function onSubmit(e: FormEvent) {
    e.preventDefault();
    send(question);
  }

  return (
    <section
      id={id}
      role="dialog"
      aria-labelledby={titleId}
      className="flex max-h-[min(70dvh,560px)] w-[min(380px,calc(100vw-2rem))] origin-bottom-right animate-slide-in flex-col overflow-hidden rounded-2xl border border-border bg-surface-strong shadow-overlay backdrop-blur-xl"
    >
      <header className="flex items-center gap-3 border-b border-border bg-linear-to-r from-primary-soft to-accent-soft px-4 py-3">
        <RobotMascot className="size-10 shrink-0" wave={false} />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold text-text">{title}</h2>
          <p className="text-xs text-muted">Answers come only from your own project's records. Nothing you type is stored.</p>
        </div>
        <button type="button" onClick={onClose} aria-label="Close assistant" className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-neutral-bg hover:text-text">
          <X aria-hidden size={18} />
        </button>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3" aria-live="polite">
        {turns.length === 0 && (
          <div className="space-y-2">
            <p className="text-sm text-muted">Try one of these:</p>
            <div className="flex flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <Button key={s} type="button" size="sm" variant="secondary" onClick={() => send(s)}>
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div
            key={i}
            className={
              t.role === "user"
                ? "ml-auto max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3 py-2 text-sm text-primary-fg"
                : "max-w-[92%] rounded-2xl rounded-bl-sm border border-border bg-surface px-3 py-2 text-sm text-text"
            }
          >
            <p className="whitespace-pre-line [overflow-wrap:anywhere]">{t.content}</p>
            {t.role === "assistant" && <p className="mt-1 text-xs text-muted">{answerNote(t)}</p>}
          </div>
        ))}
        {latest?.role === "assistant" && !ask.isPending && !!latest.suggestions?.length && (
          <div role="group" aria-labelledby={followupsId} className="space-y-1.5">
            <p id={followupsId} className="text-xs text-muted">
              Related questions
            </p>
            <div className="flex flex-wrap gap-2">
              {latest.suggestions.map((s) => (
                <Button key={s} type="button" size="sm" variant="secondary" onClick={() => send(s)} className="py-1.5 text-left whitespace-normal">
                  {s}
                </Button>
              ))}
            </div>
          </div>
        )}
        {ask.isPending && <Skeleton className="h-10 max-w-[70%] rounded-2xl" />}
        {ask.error && <p className="text-sm text-danger">{errorMessage(ask.error)}</p>}
        <div ref={endRef} />
      </div>
      <form onSubmit={onSubmit} className="flex gap-2 border-t border-border px-3 py-3">
        <Input
          ref={inputRef}
          aria-label="Your question"
          placeholder="Ask about your project…"
          value={question}
          maxLength={500}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Button type="submit" disabled={question.trim().length < 3 || ask.isPending} aria-label="Send">
          <PaperPlaneRight size={18} />
        </Button>
      </form>
    </section>
  );
}
