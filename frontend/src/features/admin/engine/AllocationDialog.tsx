import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useMemo, useRef, useState } from "react";

import { api, call } from "@/api/client";
import { ApiError } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Allocation, Recommendation } from "@/api/types";
import { FormField, LoadingState, useToast } from "@/components/shared";
import { Alert, Button, Dialog, Select, Textarea } from "@/components/ui";
import { RecommendationCard } from "@/features/shared/views";

import { invalidateAllocationWrites, usePublishedProjects } from "./hooks";
import {
  OVERRIDE_MAX, allocationBody, allocationErrorText, knownIneligibility, overrideReasonsFrom, validateOverrideReason,
} from "./lib";

type TraineeLite = { id: string; full_name: string; trainee_code: string };

export type AllocationDialogTarget =
  | { mode: "create"; trainee?: TraineeLite }
  | { mode: "reassign"; allocation: Allocation };

/** ALLOC-03 (manual allocate) / ALLOC-04 (reassign) with the server-driven override-reason flow. */
export function AllocationDialog({ target, cycleId, onClose }: {
  target: AllocationDialogTarget | null; cycleId: string; onClose: () => void;
}) {
  const title = target?.mode === "reassign" ? `Reassign ${target.allocation.trainee.full_name}` : "Allocate manually";
  return (
    <Dialog open={!!target} onClose={onClose} title={title}>
      {target && <AllocationForm target={target} cycleId={cycleId} onClose={onClose} />}
    </Dialog>
  );
}

const LOCKING_CODES = new Set(["TRAINEE_ALREADY_ALLOCATED", "PROJECT_NOT_AVAILABLE", "TRAINEE_HAS_SUBMISSIONS"]);

function AllocationForm({ target, cycleId, onClose }: { target: AllocationDialogTarget; cycleId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const ids = { trainee: useId(), project: useId(), reason: useId() };
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const fixedTrainee = target.mode === "reassign" ? target.allocation.trainee : target.trainee;
  const currentProjectId = target.mode === "reassign" ? target.allocation.project.id : undefined;

  const [traineeId, setTraineeId] = useState(fixedTrainee?.id ?? "");
  const [projectId, setProjectId] = useState("");
  const [reason, setReason] = useState("");
  const [serverReasons, setServerReasons] = useState<string[] | null>(null);
  const [errors, setErrors] = useState<{ trainee?: string; project?: string; reason?: string; form?: string }>({});

  const unallocParams = { cycle_id: cycleId, allocated: false, sort: "full_name", page_size: 100 };
  const unallocated = useQuery({
    queryKey: qk.trainees.list(unallocParams),
    queryFn: () => call(api.GET("/api/v1/trainees", { params: { query: unallocParams } })),
    enabled: !fixedTrainee,
  });
  const projects = usePublishedProjects(cycleId);
  const recParams = { cycle_id: cycleId, trainee_id: traineeId, sort: "rank", page_size: 20 };
  const recs = useQuery({
    queryKey: qk.recommendations.list(recParams),
    queryFn: () => call(api.GET("/api/v1/recommendations", { params: { query: recParams } })),
    enabled: !!traineeId,
  });
  const recByProject = useMemo(() => {
    const m = new Map<string, Recommendation>();
    for (const r of recs.data?.data ?? []) m.set(r.project.id, r);
    return m;
  }, [recs.data]);

  const known = projectId ? knownIneligibility(recByProject.get(projectId)) : null;
  const reasons = serverReasons ?? known;
  const reasonShown = reasons !== null;

  useEffect(() => {
    if (serverReasons) reasonRef.current?.focus();
  }, [serverReasons]);

  const chooseProject = (id: string) => {
    setProjectId(id);
    setServerReasons(null);
    setErrors({});
  };

  const m = useMutation({
    mutationFn: async () => {
      const body = allocationBody({ project_id: projectId }, reasonShown, reason);
      if (target.mode === "reassign") {
        return call(api.PATCH("/api/v1/allocations/{allocation_id}", { params: { path: { allocation_id: target.allocation.id } }, body }));
      }
      return call(api.POST("/api/v1/allocations", { body: { ...body, trainee_id: traineeId } }));
    },
    onSuccess: (res) => {
      invalidateAllocationWrites(qc);
      const a = res.data;
      toast.success(`${a.trainee.full_name} → ${a.project.title}${a.is_override ? " (override)" : ""}`);
      for (const w of res.meta?.warnings ?? []) toast.info(w);
      onClose();
    },
    onError: (e) => {
      const asked = overrideReasonsFrom(e);
      if (asked) {
        setServerReasons(asked);
        setErrors({ reason: reasonShown && reason.trim() ? validateOverrideReason(reason) ?? undefined : "An override reason is required for this pair" });
        return;
      }
      if (e instanceof ApiError && e.code === "PROJECT_FULL") {
        setErrors({ project: allocationErrorText(e) });
        void qc.invalidateQueries({ queryKey: qk.projects.all() });
        return;
      }
      if (e instanceof ApiError && e.code === "INVALID_STATE" && target.mode === "reassign" && projectId === currentProjectId) {
        setErrors({ project: "Choose a different project" });
        return;
      }
      if (e instanceof ApiError && e.code === "VALIDATION_ERROR") {
        const f = e.fieldErrors();
        setErrors({ trainee: f.trainee_id, project: f.project_id, reason: f.override_reason, form: Object.keys(f).length ? undefined : allocationErrorText(e) });
        return;
      }
      if (e instanceof ApiError && LOCKING_CODES.has(e.code)) invalidateAllocationWrites(qc);
      setErrors({ form: allocationErrorText(e) });
    },
  });

  const submit = () => {
    const next: typeof errors = {};
    if (!traineeId) next.trainee = "Choose a trainee";
    if (!projectId) next.project = "Choose a project";
    else if (projectId === currentProjectId) next.project = "Choose a different project";
    if (reasonShown) next.reason = validateOverrideReason(reason) ?? undefined;
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;
    m.mutate();
  };

  const recList = recs.data?.data ?? [];
  return (
    <form className="flex flex-col gap-4" noValidate onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {target.mode === "reassign" && (
        <p className="text-sm text-muted">Currently on <span className="font-medium text-text">{target.allocation.project.title}</span>. Reassigning makes this a manual allocation.</p>
      )}
      <FormField label="Trainee" htmlFor={ids.trainee} required error={errors.trainee}
        hint={!fixedTrainee ? "Only trainees without an allocation are listed." : undefined}>
        {fixedTrainee ? (
          <p id={ids.trainee} className="text-sm">{fixedTrainee.full_name} · {fixedTrainee.trainee_code}</p>
        ) : (
          <Select id={ids.trainee} value={traineeId} disabled={unallocated.isLoading}
            onChange={(e) => { setTraineeId(e.target.value); chooseProject(""); }}>
            <option value="">{unallocated.isLoading ? "Loading…" : unallocated.data?.data.length ? "Choose a trainee" : "Every trainee is allocated"}</option>
            {unallocated.data?.data.map((t) => <option key={t.id} value={t.id}>{t.full_name} · {t.trainee_code} · {t.trade.name}</option>)}
          </Select>
        )}
      </FormField>

      <FormField label="Project" htmlFor={ids.project} required error={errors.project} hint="Published projects; allocated / capacity shown.">
        <Select id={ids.project} value={projectId} disabled={projects.isLoading} onChange={(e) => chooseProject(e.target.value)}>
          <option value="">{projects.isLoading ? "Loading…" : "Choose a project"}</option>
          {projects.data?.data.map((p) => {
            const used = p.stats?.allocated_count;
            const full = used != null && used >= p.max_trainees;
            const rec = recByProject.get(p.id);
            return (
              <option key={p.id} value={p.id} disabled={p.id === currentProjectId}>
                {p.title} · {p.project_code} · {used ?? "?"}/{p.max_trainees}{full ? " (full)" : ""}
                {rec ? ` · score ${rec.score}${rec.eligible ? "" : " · ineligible"}` : ""}{p.id === currentProjectId ? " (current)" : ""}
              </option>
            );
          })}
        </Select>
      </FormField>

      {traineeId && (
        <details className="rounded-md border border-border p-2 text-sm" open={recList.length > 0 && recList.length <= 5}>
          <summary className="cursor-pointer font-medium">Recommendations for this trainee ({recList.length})</summary>
          {recs.isLoading ? <LoadingState /> : !recList.length ? (
            <p className="mt-2 text-muted">No recommendations for this trainee in the latest completed run. A manual pick without a recommendation has no match score.</p>
          ) : (
            <div className="mt-2 flex max-h-72 flex-col gap-2 overflow-y-auto">
              {recList.map((r) => (
                <RecommendationCard key={r.id} recommendation={r} perspective="trainee" compact
                  actions={<Button size="sm" variant={projectId === r.project.id ? "primary" : "secondary"}
                    disabled={r.project.id === currentProjectId} onClick={() => chooseProject(r.project.id)}>
                    {projectId === r.project.id ? "Chosen" : "Choose"}
                  </Button>} />
              ))}
            </div>
          )}
        </details>
      )}

      {reasonShown && (
        <div className="flex flex-col gap-2">
          <Alert variant="warning" title="This pair is ineligible">
            <ul className="list-disc pl-5">{reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            Allocating anyway is an override; it is recorded with your reason and shown to the programme team.
          </Alert>
          <FormField label="Override reason" htmlFor={ids.reason} required error={errors.reason}
            hint={`${reason.trim().length} / ${OVERRIDE_MAX} characters (minimum 10)`}>
            <Textarea id={ids.reason} ref={reasonRef} value={reason} maxLength={OVERRIDE_MAX}
              aria-invalid={!!errors.reason} onChange={(e) => setReason(e.target.value)} />
          </FormField>
        </div>
      )}

      {errors.form && <Alert variant="danger">{errors.form}</Alert>}

      <div className="flex justify-end gap-2 border-t border-border pt-3">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button type="submit" loading={m.isPending}>{reasonShown ? "Allocate with override" : target.mode === "reassign" ? "Reassign" : "Allocate"}</Button>
      </div>
    </form>
  );
}
