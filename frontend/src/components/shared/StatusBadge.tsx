import { label, type BadgeKind } from "@/lib/statusLabels";

const STYLES = {
  info: "bg-info-bg text-info border-info/20",
  success: "bg-success-bg text-success border-success/20",
  warning: "bg-warning-bg text-warning border-warning/20",
  danger: "bg-danger-bg text-danger border-danger/20",
  neutral: "bg-neutral-bg text-neutral border-border",
};

export function StatusBadge({ kind, value }: { kind: BadgeKind; value: string }) {
  const [text, variant] = label(kind, value);
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap ${STYLES[variant]}`}>
      {text}
    </span>
  );
}
