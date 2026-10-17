import type { ReactNode } from "react";
import { Link } from "react-router-dom";

import type { Allocation, Cycle } from "@/api/types";
import { DateTime, KeyValue, ScoreBar } from "@/components/shared";
import { Alert, Card } from "@/components/ui";
import { FactorTable } from "@/features/shared/views";

/** Own allocation (student.md §3.2 allocation card / §3.7 allocation panel). `override_reason` is never rendered. */
export function AllocationPanel({ allocation: a, cycle, defaultOpen }: { allocation: Allocation; cycle: Cycle | null; defaultOpen?: boolean }) {
  const sup = a.project.supervisor;
  return (
    <Card title="Your allocated project">
      <KeyValue
        items={[
          ["Project", <Link key="p" className="text-primary underline" to={`/student/projects/${a.project.id}`}>{a.project.project_code} · {a.project.title}</Link>],
          ["Supervisor", sup ? (
            <span key="s" className="break-words">
              {sup.full_name}
              {sup.department && <span className="text-muted"> · {sup.department}</span>}
              <br />
              <a className="text-primary underline break-all" href={`mailto:${sup.email}`}>{sup.email}</a>
            </span>
          ) : "Supervisor to be confirmed"],
          ...(a.match_score != null ? [["Match score", <ScoreBar key="m" value={a.match_score} label="Match score" />] as [string, ReactNode]] : []),
          ...(cycle ? [["Submission deadline", <DateTime key="d" value={cycle.submission_deadline} />] as [string, ReactNode]] : []),
        ]}
      />
      {a.factors ? (
        <details className="mt-3 text-sm" open={defaultOpen}>
          <summary className="cursor-pointer text-primary">Why this project</summary>
          <FactorTable factors={a.factors} />
        </details>
      ) : (
        <div className="mt-3">
          <Alert variant="info">This project was assigned directly by the programme team, so there is no factor breakdown.</Alert>
        </div>
      )}
    </Card>
  );
}

/** Shown instead of the allocation when none is visible yet. */
export function NoAllocationPanel({ cycle }: { cycle: Cycle | null }) {
  return (
    <Card title="Your allocated project">
      <p className="text-sm text-muted">
        {cycle?.status === "published"
          ? "You have not been allocated a project in this cycle. Contact your coordinator."
          : "Allocations are not published yet. Your programme team will publish them after reviewing suggestions."}
      </p>
    </Card>
  );
}
