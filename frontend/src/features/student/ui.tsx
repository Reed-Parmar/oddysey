/** Student-module presentational helpers (layout only; no data fetching). Owned by the Student module. */
import { ArrowRight } from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import { cx } from "@/components/ui";

const LINK_VARIANTS = {
  primary: "bg-primary text-primary-fg shadow-card hover:bg-primary-hover",
  secondary: "border border-border-strong bg-surface text-text shadow-card hover:border-subtle hover:bg-surface-2",
  ghost: "text-primary hover:bg-primary-soft",
};

/** A router link styled like a Button (for navigation actions). */
export function LinkButton({ to, children, variant = "primary", size = "md", icon, trailing, className }: {
  to: string;
  children: ReactNode;
  variant?: keyof typeof LINK_VARIANTS;
  size?: "sm" | "md";
  icon?: ReactNode;
  /** Show a trailing arrow. */
  trailing?: boolean;
  className?: string;
}) {
  return (
    <Link
      to={to}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-lg py-1.5 text-center font-semibold transition-colors duration-150",
        size === "sm" ? "min-h-9 px-3 text-sm" : "min-h-10 px-4 text-sm",
        LINK_VARIANTS[variant],
        className,
      )}
    >
      {icon && <span aria-hidden className="inline-flex shrink-0 [&>svg]:size-4">{icon}</span>}
      {children}
      {trailing && <ArrowRight aria-hidden size={16} className="shrink-0" />}
    </Link>
  );
}

/** Small text link with an arrow, for card header actions. */
export function TextLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex min-h-9 items-center gap-1 rounded text-sm font-semibold text-primary transition-colors hover:text-primary-ink">
      {children}
      <ArrowRight aria-hidden size={14} />
    </Link>
  );
}

/** A labelled read-only value tile. */
export function Fact({ label, children, icon }: { label: string; children: ReactNode; icon?: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
        {icon && <span aria-hidden className="inline-flex [&>svg]:size-3.5">{icon}</span>}
        {label}
      </dt>
      <dd className="mt-1 text-sm font-medium text-text [overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}
