import { label, type BadgeKind } from "@/lib/statusLabels";

const STYLES = {
  info: "bg-info-bg text-info border-info/20",
  success: "bg-success-bg text-success border-success/20",
  warning: "bg-warning-bg text-warning border-warning/25",
  danger: "bg-danger-bg text-danger border-danger/20",
  neutral: "bg-neutral-bg text-neutral border-border",
};

const DOT = {
  info: "bg-info",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  neutral: "bg-subtle",
};

export function StatusBadge({ kind, value }: { kind: BadgeKind; value: string }) {
  const [text, variant] = label(kind, value);
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${STYLES[variant]}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${DOT[variant]}`} />
      {text}
    </span>
  );
}
