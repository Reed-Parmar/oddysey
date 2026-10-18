import { Archive, Bell, CaretRight, Checks, Compass, Hourglass, Kanban } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";

import { api, call } from "@/api/client";
import { errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Allocation, Submission } from "@/api/types";
import { DateTime, ErrorState, LoadingState, PageHeader, Skeleton, StatusBadge, useToast } from "@/components/shared";
import { Pipeline } from "@/components/shared/Pipeline";
import { Alert, Button, Card, cx } from "@/components/ui";

import { WAITING_AFTER_REJECT_TEXT, WAITING_TEXT, lastRejected, nextStep } from "./forms";
import { buildJourney } from "./journey";
import { useMyAllocationHistory, useMyNotifications, useMySubmissionHistory, useProject, useStudentContext } from "./hooks";
import { Fact, LinkButton } from "./ui";
import { AlertsPanel } from "@/features/shared/Autopilot";

export function DashboardPage() {
  const { cycle, me } = useStudentContext();
  const allocation = me?.allocation ?? null;
  const subs = useMySubmissionHistory(!!allocation);
  const history = useMyAllocationHistory();
  const project = useProject(allocation?.project.id);

  if (!cycle || !me) return <LoadingState />;
  const versions = (subs.data?.data ?? []).filter((s) => s.allocation_id === allocation?.id);
  const latest = versions[0];
  const rejectedBefore = !!lastRejected(history.data?.data);
  const deadline = project.data?.data.effective_deadline ?? cycle.submission_deadline;
  const step = nextStep(cycle, me, latest, { deadline, rejectedBefore });

  const journey = buildJourney(me, allocation, latest, { rejectedBefore });

  return (
    <div className="space-y-6">
      <PageHeader eyebrow={cycle.name} title={`Welcome, ${me.full_name}`} description="Your project journey in this programme cycle at a glance." />

      <AlertsPanel />

      {cycle.status === "archived" && (
        <Alert variant="info" icon={<Archive />} title="This cycle is archived">Your project and results are kept read-only.</Alert>
      )}

      <section className="rounded-xl border border-primary/25 bg-primary-soft bg-linear-to-br from-primary-soft via-surface to-violet-soft p-5 shadow-card" aria-labelledby="next-step-title">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span aria-hidden className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary bg-linear-to-b from-white/20 to-transparent text-primary-fg shadow-btn">
              <Compass size={20} />
            </span>
            <div className="min-w-0">
              <h2 id="next-step-title" className="text-xs font-semibold tracking-wide text-primary-ink uppercase">Next step</h2>
              <p className="mt-0.5 font-heading text-lg font-semibold text-text">{step.text}</p>
              {allocation && subs.isLoading && <p className="mt-1 text-xs text-muted">Checking your submissions…</p>}
            </div>
          </div>
          {step.to && step.cta && (
            <LinkButton to={step.to} size="md" trailing className="w-full sm:w-auto">
              {step.cta}
            </LinkButton>
          )}
        </div>
      </section>

      <section aria-labelledby="journey-title">
        <Pipeline
          label="Your project journey"
          stages={journey}
          columns={4}
          toolbar={
            <div className="min-w-0">
              <h2 id="journey-title" className="text-base font-semibold text-text">Your journey</h2>
              <p className="text-xs text-muted">Each stage updates on its own as the programme's automation runs. Select a stage to learn more.</p>
            </div>
          }
        />
      </section>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start">
        <MyProjectCard
          allocation={allocation}
          deadline={allocation ? deadline : null}
          latest={latest}
          loadingSubs={!!allocation && subs.isLoading}
          rejectedBefore={rejectedBefore}
        />
        <NotificationsCard />
      </div>

    </div>
  );
}

function MyProjectCard({ allocation: a, deadline, latest, loadingSubs, rejectedBefore }: {
  allocation: Allocation | null; deadline: string | null; latest: Submission | undefined; loadingSubs: boolean; rejectedBefore: boolean;
}) {
  if (!a)
    return (
      <Card title="My project" icon={<Hourglass />}>
        <p className="text-sm text-text">{rejectedBefore ? WAITING_AFTER_REJECT_TEXT : WAITING_TEXT}</p>
        <p className="mt-2 text-xs text-muted">You'll get a notification here as soon as your project is ready. Meanwhile, keep your profile up to date on the Profile page.</p>
      </Card>
    );
  const sup = a.project.supervisor;
  return (
    <Card title="My project" icon={<Kanban />}>
      <Link
        to="/student/project"
        className="group flex items-center justify-between gap-3 rounded-lg border border-primary/25 bg-primary-soft px-4 py-3 transition-colors hover:border-primary/50"
      >
        <span className="min-w-0">
          <span className="block text-xs font-semibold tracking-wide text-primary-ink uppercase">{a.project.project_code}</span>
          <span className="block font-heading text-base font-semibold text-text [overflow-wrap:anywhere]">{a.project.title}</span>
        </span>
        <CaretRight aria-hidden size={18} className="shrink-0 text-primary transition-transform group-hover:translate-x-0.5" />
      </Link>
      <dl className="mt-4 grid gap-4 sm:grid-cols-3">
        <Fact label="Supervisor">{sup ? sup.full_name : <span className="text-muted">Being assigned</span>}</Fact>
        <Fact label="Deadline">{deadline ? <DateTime value={deadline} /> : "—"}</Fact>
        <Fact label="Latest submission">
          {loadingSubs ? <Skeleton className="h-5 w-24" /> : latest ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <span>Version {latest.version}</span>
              <StatusBadge kind="submission" value={latest.status} />
            </span>
          ) : <span className="text-muted">Not submitted yet</span>}
        </Fact>
      </dl>
      <div className="mt-4">
        <LinkButton to="/student/project" variant="secondary" size="sm" trailing>Open My Project</LinkButton>
      </div>
    </Card>
  );
}

function NotificationsCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useMyNotifications();
  const items = q.data?.data ?? [];
  const unread = items.filter((n) => !n.read_at).length;
  const markRead = useMutation({
    mutationFn: () => call(api.POST("/api/v1/me/notifications/read")),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.notifications.me() }),
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Card
      title="Notifications"
      icon={<Bell />}
      description={unread ? `${unread} unread` : undefined}
      actions={
        <Button size="sm" variant="ghost" icon={<Checks />} disabled={!unread} loading={markRead.isPending} onClick={() => markRead.mutate()}>
          Mark all read
        </Button>
      }
    >
      {q.isLoading ? (
        <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
      ) : q.error ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} />
      ) : !items.length ? (
        <p className="text-sm text-muted">No notifications yet. Updates about your allocation and evaluation appear here.</p>
      ) : (
        <ul className="-mx-1 flex max-h-96 flex-col gap-1 overflow-y-auto px-1">
          {items.slice(0, 20).map((n) => {
            const body = (
              <>
                <span className="flex items-start justify-between gap-2">
                  <span className={cx("min-w-0 text-sm [overflow-wrap:anywhere]", n.read_at ? "text-text" : "font-semibold text-text")}>
                    {!n.read_at && <span className="sr-only">Unread: </span>}
                    {n.subject}
                  </span>
                  {!n.read_at && <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-primary" />}
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">{n.body}</span>
                <span className="mt-1 block text-xs text-subtle"><DateTime value={n.created_at} /></span>
              </>
            );
            const cls = cx("block rounded-lg px-3 py-2", !n.read_at && "bg-primary-soft/60");
            return (
              <li key={n.id}>
                {n.link?.startsWith("/") ? (
                  <Link to={n.link} className={cx(cls, "transition-colors hover:bg-surface-2")}>{body}</Link>
                ) : (
                  <div className={cls}>{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
