import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import type { Cycle } from "@/api/types";
import { EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/shared";
import { useCurrentCycle } from "@/app/AppShell";

/** Resolves the active cycle and renders loading / error / "Create a cycle first" before the page body. */
export function WithCycle({ title, description, children }: {
  title: string; description?: ReactNode; children: (cycle: Cycle) => ReactNode;
}) {
  const cycle = useCurrentCycle();
  if (cycle.isLoading) return <><PageHeader title={title} description={description} /><LoadingState /></>;
  if (cycle.error) return <><PageHeader title={title} description={description} /><ErrorState error={cycle.error} onRetry={() => void cycle.refetch()} /></>;
  const c = cycle.data?.data;
  if (!c) {
    return (
      <>
        <PageHeader title={title} description={description} />
        <EmptyState title="Create a cycle first" description="All planning happens inside the active cycle."
          action={<Link className="text-primary underline" to="/admin/cycles">Go to cycles</Link>} />
      </>
    );
  }
  return <>{children(c)}</>;
}

/** Small "disabled with reason" note shown next to a disabled action. */
export function Reason({ children, id }: { children?: ReactNode; id?: string }) {
  if (!children) return null;
  return <p id={id} className="text-xs text-muted">{children}</p>;
}
