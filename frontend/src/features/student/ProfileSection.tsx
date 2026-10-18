/** Profile page sections (ADR-024): programme-managed facts, resume, and the self-editable profile. */
import { FloppyDisk, IdentificationCard, LockKey, NotePencil, SealCheck } from "@phosphor-icons/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { api, call } from "@/api/client";
import { ApiError } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { TraineeMe } from "@/api/types";
import { Avatar, FormError, FormField, ScoreBar, SkillChips, StatusBadge, useToast } from "@/components/shared";
import { Button, Card, Textarea } from "@/components/ui";

import { TradePicker } from "./fields";
import { BACKGROUND_MAX, profileBody, profileSchema, type ProfileValues } from "./forms";
import { useMyResume } from "./hooks";
import { ResumePanel } from "./ResumePanel";
import { Fact } from "./ui";

const MODE_TEXT: Record<string, string> = {
  full: "Your programme team has entered all verified marks, so matching uses practical, skills, interest, theory and safety.",
  profile: "Verified marks are not complete yet, so matching uses your skills and career interest only (profile fit, not competence).",
};

/** Fields owned by the programme team (read-only for the trainee). Gender is never shown here. */
function ManagedRecord({ me }: { me: TraineeMe }) {
  const scores = [["Theory", me.scores.theory], ["Practical", me.scores.practical], ["Safety compliance", me.scores.safety]] as const;
  return (
    <Card
      title="Programme record"
      description="Managed by your programme team. Ask your coordinator if something is wrong."
      icon={<LockKey />}
    >
      <div className="flex items-center gap-3 rounded-lg bg-surface-2 p-3">
        <Avatar name={me.full_name} />
        <div className="min-w-0">
          <p className="font-semibold text-text [overflow-wrap:anywhere]">{me.full_name}</p>
          <p className="flex items-center gap-1 text-xs text-muted">
            <IdentificationCard aria-hidden size={14} />
            <span className="sr-only">Trainee code: </span>
            {me.trainee_code}
          </p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4">
        <Fact label="Trainee code">{me.trainee_code}</Fact>
        <Fact label="Training centre">{me.centre_name ?? "—"}</Fact>
        <div className="col-span-2">
          <Fact label="Matching mode">
            <span className="flex flex-col items-start gap-1.5">
              <StatusBadge kind="matchMode" value={me.match_mode} />
              <span className="text-xs font-normal text-muted">{MODE_TEXT[me.match_mode] ?? ""}</span>
            </span>
          </Fact>
        </div>
      </dl>
      <h3 className="mt-5 mb-1 flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted uppercase">
        <SealCheck aria-hidden size={14} className="text-success" />
        Assessment marks · Verified (programme)
      </h3>
      <p className="mb-3 text-xs text-muted">Entered by your programme team. These are authoritative and can't be edited here.</p>
      <dl className="flex flex-col gap-3">
        {scores.map(([k, v]) => (
          <div key={k} className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-sm text-muted">{k}</dt>
            <dd>{v == null ? <span className="text-sm text-muted">Not entered yet</span> : <ScoreBar value={v} label={k} tone="auto" />}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

const FIELD_KEYS = ["trade_ids", "skills", "career_interest", "background"] as const;

function ProfileForm({ me }: { me: TraineeMe }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [formError, setFormError] = useState<unknown>(null);
  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      trade_ids: me.trades.map((t) => t.id),
      skills: me.skills.map((s) => s.name),
      career_interest: me.career_interest ?? "",
      background: me.background ?? "",
    },
  });
  const { register, handleSubmit, setValue, watch, setError, formState } = form;
  const [tradeIds, background] = watch(["trade_ids", "background"]);
  const hasResume = !!useMyResume().data?.data;

  const save = useMutation({
    mutationFn: (v: ProfileValues) => call(api.PATCH("/api/v1/trainees/me", { body: profileBody(v) })),
    onSuccess: async () => {
      toast.success("Profile saved");
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.trainees.me() }),
        qc.invalidateQueries({ queryKey: qk.resumes.me() }),
        qc.invalidateQueries({ queryKey: qk.skills.all() }),
      ]);
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        if (e.code === "NO_ACTIVE_CYCLE") void qc.invalidateQueries({ queryKey: qk.cycles.current() });
        if (e.code === "NO_TRAINEE_RECORD") void qc.invalidateQueries({ queryKey: qk.trainees.me() });
        const fields = e.fieldErrors();
        const unmapped: string[] = [];
        for (const [f, msg] of Object.entries(fields)) {
          const key = FIELD_KEYS.find((k) => f === k || f.startsWith(`${k}.`));
          if (key) setError(key, { message: msg });
          else unmapped.push(msg);
        }
        if (Object.keys(fields).length && !unmapped.length) {
          setFormError(null);
          return;
        }
      }
      setFormError(e);
    },
  });

  return (
    <Card title="About you" description="Used the next time projects are matched." icon={<NotePencil />}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={handleSubmit((v) => {
          setFormError(null);
          save.mutate(v);
        })}
      >
        <TradePicker
          required
          value={tradeIds}
          onChange={(v) => setValue("trade_ids", v, { shouldDirty: true, shouldValidate: true })}
          error={formState.errors.trade_ids?.message}
        />
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface-2 p-4">
          <div>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-text">
              Skills <LockKey aria-hidden size={14} className="text-subtle" /><span className="sr-only">(read-only)</span>
            </p>
            <div className="mt-2"><SkillChips skills={me.skills} /></div>
          </div>
          <div>
            <p className="flex items-center gap-1.5 text-sm font-semibold text-text">
              Career interest <LockKey aria-hidden size={14} className="text-subtle" /><span className="sr-only">(read-only)</span>
            </p>
            <p className="mt-1 text-sm text-text [overflow-wrap:anywhere]">{me.career_interest || <span className="text-muted">Not set</span>}</p>
          </div>
          <p className="text-xs text-muted">
            {hasResume
              ? "These come from your resume. To change them, upload a new resume in Update resume above and save its suggestions."
              : "These come from your resume. Upload your resume in Update resume above to add or change them."}
          </p>
        </div>
        <FormField
          label="Background"
          htmlFor="background"
          error={formState.errors.background?.message}
          hint={`${background.length} / ${BACKGROUND_MAX}`}
        >
          <Textarea id="background" rows={4} maxLength={BACKGROUND_MAX} placeholder="Prior work, hobbies, projects you have done…" {...register("background")} />
        </FormField>
        <FormError error={formError} />
        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted">Changes don't move a project you already have.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" icon={<FloppyDisk />} loading={save.isPending} disabled={!formState.isDirty}>
              Save changes
            </Button>
            <Button variant="secondary" disabled={!formState.isDirty || save.isPending} onClick={() => form.reset()}>
              Discard changes
            </Button>
          </div>
        </div>
      </form>
    </Card>
  );
}

/** The Profile page body (ADR-024): resume first (it fills skills and interest), then the editable profile. */
export function ProfileSection({ me }: { me: TraineeMe }) {
  return (
    <section id="profile" aria-label="My profile" className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:items-start">
      <ManagedRecord me={me} />
      <div className="min-w-0 space-y-6">
        <ResumePanel me={me} />
        <ProfileForm key={me.updated_at} me={me} />
      </div>
    </section>
  );
}
