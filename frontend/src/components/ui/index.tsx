/** Minimal accessible primitives (shadcn-style, Tailwind tokens). Owned by the foundation. */
import { X } from "@phosphor-icons/react";
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost" | "accent";
  size?: "sm" | "md" | "lg";
  loading?: boolean;
  /** Leading icon (decorative; the button text is the accessible name). */
  icon?: ReactNode;
};

/* Solid variants: base colour + a top-light gradient + a bevelled shadow (3D); pressing nudges them down. */
const GLOSS = "bg-linear-to-b from-white/20 to-transparent shadow-btn";
const BUTTON_VARIANTS = {
  primary: `bg-primary ${GLOSS} text-primary-fg hover:bg-primary-hover`,
  accent: `bg-accent ${GLOSS} text-white hover:bg-accent-ink`,
  secondary: "border border-border-strong bg-surface-strong text-text shadow-btn-soft hover:border-subtle hover:bg-surface-2",
  danger: `bg-danger ${GLOSS} text-white hover:bg-danger/90`,
  ghost: "text-neutral hover:bg-neutral-bg hover:text-text",
};

const BUTTON_SIZES = { sm: "min-h-9 px-3 text-sm", md: "min-h-10 px-4 text-sm", lg: "min-h-12 px-5 text-base" };

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-lg font-semibold whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-150 select-none active:translate-y-px";

/** Button look for links (`<Link className={buttonStyles("secondary")}>`): never nest a <button> in an <a>. */
export function buttonStyles(variant: NonNullable<ButtonProps["variant"]> = "primary", size: NonNullable<ButtonProps["size"]> = "md") {
  return cx(BUTTON_BASE, BUTTON_SIZES[size], BUTTON_VARIANTS[variant]);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, disabled, className, children, icon, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        BUTTON_BASE,
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:shadow-none",
        BUTTON_SIZES[size],
        BUTTON_VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <span aria-hidden className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      ) : (
        icon && <span aria-hidden className="inline-flex shrink-0 [&>svg]:size-4">{icon}</span>
      )}
      {children}
    </button>
  );
});

const field = cx(
  "w-full rounded-lg border border-border-strong bg-surface px-3 py-2 text-base text-text shadow-[inset_0_1px_1px_rgb(15_23_42/0.03)] sm:text-sm",
  "placeholder:text-subtle transition-colors duration-150 hover:border-subtle",
  "focus:border-primary focus:ring-3 focus:ring-primary/15 focus:outline-none",
  "disabled:cursor-not-allowed disabled:bg-neutral-bg disabled:text-muted",
  "aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/15",
);

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...rest },
  ref,
) {
  return <input ref={ref} className={cx(field, "min-h-11 sm:min-h-10", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className, ...rest }, ref) {
    return <textarea ref={ref} className={cx(field, "min-h-24 leading-relaxed", className)} {...rest} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select
      ref={ref}
      className={cx(
        field,
        "min-h-11 appearance-none bg-[length:16px] bg-[right_0.6rem_center] bg-no-repeat pr-9 sm:min-h-10",
        "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256'%3E%3Cpath fill='%2364748b' d='M213.7 101.7l-80 80a8 8 0 0 1-11.4 0l-80-80a8 8 0 0 1 11.4-11.4L128 164.7l74.3-74.4a8 8 0 0 1 11.4 11.4Z'/%3E%3C/svg%3E\")]",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
});

/** Decorative icon-tile colours; a card keeps the same colour because it is picked from its title. */
const TILE_TONES = [
  "bg-primary-soft text-primary",
  "bg-accent-soft text-accent-ink",
  "bg-violet-soft text-violet-ink",
  "bg-clay-soft text-clay-ink",
];

function tileTone(title: ReactNode) {
  if (typeof title !== "string") return TILE_TONES[0];
  let h = 0;
  for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TILE_TONES[h % TILE_TONES.length];
}

export function Card({
  className,
  children,
  title,
  description,
  actions,
  icon,
  flush,
}: {
  className?: string;
  children: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /** Decorative icon shown before the title. */
  icon?: ReactNode;
  /** Remove body padding (for tables/lists that run edge to edge). */
  flush?: boolean;
}) {
  const hasHeader = title || actions;
  return (
    <section className={cx("rounded-xl border border-border bg-surface shadow-card", !flush && "p-5", className)}>
      {hasHeader && (
        <div className={cx("flex flex-wrap items-start justify-between gap-3", flush ? "px-5 pt-5 pb-4" : "mb-4")}>
          <div className="flex min-w-0 items-start gap-3">
            {icon && (
              <span aria-hidden className={cx("tile-3d mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg [&>svg]:size-[18px]", tileTone(title))}>
                {icon}
              </span>
            )}
            <div className="min-w-0">
              {title && <h2 className="text-base font-semibold text-text">{title}</h2>}
              {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
            </div>
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export function Alert({
  variant = "info",
  children,
  title,
  icon,
}: {
  variant?: "info" | "success" | "warning" | "danger";
  children: ReactNode;
  title?: string;
  icon?: ReactNode;
}) {
  const styles = {
    info: "border-info/25 bg-info-bg text-info",
    success: "border-success/25 bg-success-bg text-success",
    warning: "border-warning/30 bg-warning-bg text-warning",
    danger: "border-danger/25 bg-danger-bg text-danger",
  }[variant];
  return (
    <div role={variant === "danger" ? "alert" : "status"} className={cx("flex gap-3 rounded-lg border px-4 py-3 text-sm", styles)}>
      {icon && <span aria-hidden className="mt-0.5 shrink-0 [&>svg]:size-[18px]">{icon}</span>}
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        <div className={cx(title && "mt-0.5", "[overflow-wrap:anywhere]")}>{children}</div>
      </div>
    </div>
  );
}

/** Native <dialog> modal: focus is trapped by the browser; Escape closes. */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
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
      aria-labelledby={titleId}
      className={cx(
        "m-auto rounded-2xl border border-border bg-surface p-0 text-text shadow-overlay",
        size === "lg" ? "w-[min(760px,calc(100vw-2rem))]" : "w-[min(560px,calc(100vw-2rem))]",
      )}
    >
      {open && (
        <div className="flex max-h-[85dvh] flex-col">
          <div className="flex items-start justify-between gap-4 px-5 pt-5 pb-3">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold">
                {title}
              </h2>
              {description && <p className="mt-1 text-sm text-muted">{description}</p>}
            </div>
            <button
              type="button"
              aria-label="Close"
              className="-mt-1 -mr-1 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-neutral-bg hover:text-text"
              onClick={onClose}
            >
              <X aria-hidden size={18} />
            </button>
          </div>
          <div className="overflow-y-auto px-5 pb-5">{children}</div>
          {footer && (
            <div className="flex flex-wrap justify-end gap-2 rounded-b-2xl border-t border-border bg-surface-2 px-5 py-3">{footer}</div>
          )}
        </div>
      )}
    </dialog>
  );
}

export { cx };
