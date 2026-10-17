import { CheckCircle, Info, WarningCircle, X } from "@phosphor-icons/react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Toast = { id: number; kind: "success" | "error" | "info"; text: string };
const ToastContext = createContext<(kind: Toast["kind"], text: string) => void>(() => {});

const STYLE = {
  success: { icon: CheckCircle, tone: "text-success" },
  error: { icon: WarningCircle, tone: "text-danger" },
  info: { icon: Info, tone: "text-info" },
};

export function Toaster({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 7000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="fixed right-4 bottom-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => {
          const { icon: Icon, tone } = STYLE[t.kind];
          return (
            <div
              key={t.id}
              className="flex animate-slide-in items-start gap-3 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-text shadow-raised"
            >
              <Icon aria-hidden size={20} weight="fill" className={`mt-px shrink-0 ${tone}`} />
              <p className="min-w-0 flex-1 font-medium [overflow-wrap:anywhere]">{t.text}</p>
              <button
                type="button"
                aria-label="Dismiss notification"
                className="-mt-1 -mr-2 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-neutral-bg hover:text-text"
                onClick={() => dismiss(t.id)}
              >
                <X aria-hidden size={14} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const push = useContext(ToastContext);
  return {
    success: (text: string) => push("success", text),
    error: (text: string) => push("error", text),
    info: (text: string) => push("info", text),
  };
}
