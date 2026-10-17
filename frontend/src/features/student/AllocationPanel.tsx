import { CalendarBlank, CaretRight, EnvelopeSimple, Hourglass, Info, Kanban } from "@phosphor-icons/react";
import { Link } from "react-router-dom";

import type { Allocation, Cycle } from "@/api/types";
import { Avatar, DateTime, ScoreBar } from "@/components/shared";
import { Alert, Card } from "@/components/ui";

import { Fact, FactorList } from "./ui";

/** Own allocation (student.md §3.2 allocation card / §3.7 allocation panel). `override_reason` is never rendered. */
export function AllocationPanel({ allocation: a, cycle, defaultOpen }: { allocation: Allocation; cycle: Cycle | null; defaultOpen?: boolean }) {
  const sup = a.project.supervisor;
  return (
    <Card title="Your allocated project" icon={<Kanban />}>
      <Link
        to={`/student/projects/${a.project.id}`}
        className="group flex items-center justify-between gap-3 rounded-lg border border-primary/25 bg-primary-soft px-4 py-3 transition-colors hover:border-primary/50"
      >
        <span className="min-w-0">
          <span className="block text-xs font-semibold tracking-wide text-primary-ink uppercase">{a.project.project_code}</span>
          <span className="block font-heading text-base font-semibold text-text [overflow-wrap:anywhere]">{a.project.title}</span>
        </span>
        <CaretRight aria-hidden size={18} className="shrink-0 text-primary transition-transform group-hover:translate-x-0.5" />
      </Link>

      <dl className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Fact label="Supervisor">
          {sup ? (
            <span className="flex items-start gap-2.5">
              <Avatar name={sup.full_name} size="sm" />
              <span className="min-w-0">
                <span className="block">
                  {sup.full_name}
                  {sup.department && <span className="font-normal text-muted"> · {sup.department}</span>}
                </span>
                <a className="inline-flex items-center gap-1 font-normal break-all text-primary hover:underline" href={`mailto:${sup.email}`}>
                  <EnvelopeSimple aria-hidden size={14} className="shrink-0" />
                  {sup.email}
                </a>
              </span>
            </span>
          ) : (
            <span className="text-muted">Supervisor to be confirmed</span>
          )}
        </Fact>
        {a.match_score != null && (
          <Fact label="Match score">
            <ScoreBar value={a.match_score} label="Match score" tone="auto" />
          </Fact>
        )}
        {cycle && (
          <Fact label="Submission deadline" icon={<CalendarBlank />}>
            <DateTime value={cycle.submission_deadline} />
          </Fact>
        )}
      </dl>

      {a.factors ? (
        <details className="mt-4 text-sm" open={defaultOpen}>
          <summary className="inline-flex min-h-9 cursor-pointer items-center gap-1.5 font-semibold text-primary">
            <Info aria-hidden size={16} />
            Why this project
          </summary>
          <FactorList factors={a.factors} total={a.match_score} />
        </details>
      ) : (
        <div className="mt-4">
          <Alert variant="info" icon={<Info />}>This project was assigned directly by the programme team, so there is no factor breakdown.</Alert>
        </div>
      )}
    </Card>
  );
}

/** Shown instead of the allocation when none is visible yet. */
export function NoAllocationPanel({ cycle }: { cycle: Cycle | null }) {
  return (
    <Card title="Your allocated project" icon={<Hourglass />}>
      <p className="max-w-3xl text-sm text-muted">
        {cycle?.status === "published"
          ? "You have not been allocated a project in this cycle. Contact your coordinator."
          : "Allocations are not published yet. Your programme team will publish them after reviewing suggestions."}
      </p>
    </Card>
  );
}
