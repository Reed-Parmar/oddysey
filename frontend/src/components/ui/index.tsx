/** Minimal accessible primitives (shadcn-style, Tailwind tokens). Owned by the foundation. */
import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
  loading?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, disabled, className, children, type = "button", ...rest },
  ref,
) {
  const styles = {
    primary: "bg-primary text-primary-fg hover:bg-primary/90",
    secondary: "border border-border bg-surface hover:bg-neutral-bg",
    danger: "bg-danger text-white hover:bg-danger/90",
    ghost: "hover:bg-neutral-bg",
  }[variant];
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-md font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        size === "sm" ? "px-3 text-sm" : "px-4 text-sm",
        styles,
        className,
      )}
      {...rest}
    >
      {loading && <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
      {children}
    </button>
  );
});

const field = "w-full rounded-md border border-border bg-surface px-3 py-2 text-sm disabled:bg-neutral-bg";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(field, "min-h-10", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx(field, "min-h-24", className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cx(field, "min-h-10", className)} {...rest}>
      {children}
    </select>
  );
});

export function Card({ className, children, title, actions }: { className?: string; children: ReactNode; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cx("rounded-lg border border-border bg-surface p-4", className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Alert({ variant = "info", children, title }: { variant?: "info" | "success" | "warning" | "danger"; children: ReactNode; title?: string }) {
  const styles = {
    info: "border-info/30 bg-info-bg text-info",
    success: "border-success/30 bg-success-bg text-success",
    warning: "border-warning/30 bg-warning-bg text-warning",
    danger: "border-danger/30 bg-danger-bg text-danger",
  }[variant];
  return (
    <div role={variant === "danger" ? "alert" : "status"} className={cx("rounded-md border px-3 py-2 text-sm", styles)}>
      {title && <p className="font-medium">{title}</p>}
      <div>{children}</div>
    </div>
  );
}

/** Native <dialog> modal: focus is trapped by the browser; Escape closes. */
export function Dialog({ open, onClose, title, children, footer }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="dialog-title"
      className="m-auto w-[min(560px,calc(100vw-2rem))] rounded-lg border border-border p-0 backdrop:bg-black/40"
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 id="dialog-title" className="font-semibold">
              {title}
            </h2>
            <button type="button" aria-label="Close" className="rounded p-1 hover:bg-neutral-bg" onClick={onClose}>
              ✕
            </button>
          </div>
          <div className="overflow-y-auto px-4 py-3">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border px-4 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export { cx };
