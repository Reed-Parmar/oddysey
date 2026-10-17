import { FloppyDisk, IdentificationCard, LockKey, NotePencil, X } from "@phosphor-icons/react";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useForm } from "react-hook-form";

import { api, call } from "@/api/client";
import { ApiError } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { TraineeMe } from "@/api/types";
import { Avatar, FormError, FormField, LoadingState, PageHeader, ScoreBar, StatusBadge, useToast } from "@/components/shared";
import { Button, Card, Input, Textarea } from "@/components/ui";

import { BACKGROUND_MAX, CAREER_MAX, SKILL_MAX, normaliseSkills, profileBody, profileSchema, skillAddError, type ProfileValues } from "./forms";
import { useStudentContext } from "./hooks";
import { ResumePanel } from "./ResumePanel";
import { Fact } from "./ui";

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** Multi-input with SKL-01 suggestions (native datalist); free names are allowed. */
function SkillsInput({ value, onChange, error }: { value: string[]; onChange: (v: string[]) => void; error?: string }) {
  const [draft, setDraft] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const listId = useId();
  const q = useDebounced(draft.trim());
  const suggestions = useQuery({
    queryKey: qk.skills.list(q || undefined),
    queryFn: () => call(api.GET("/api/v1/skills", { params: { query: q ? { q } : {} } })),
    enabled: q.length >= 1 && q.length <= 100,
    staleTime: 60_000,
  });
  const taken = new Set(value.map((s) => s.toLowerCase()));
  const options = (suggestions.data?.data ?? []).filter((s) => !taken.has(s.name.toLowerCase())).slice(0, 15);

  const add = () => {
    const err = skillAddError(value, draft);
    if (err) {
      setLocalError(draft.trim() ? err : null);
      return;
    }
    onChange(normaliseSkills([...value, draft]));
    setDraft("");
    setLocalError(null);
  };

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5" aria-label="Your skills">
          {value.map((s) => (
            <li key={s.toLowerCase()} className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary-soft py-0.5 pr-0.5 pl-3 text-sm font-medium text-primary-ink">
              {s}
              <button
                type="button"
                className="inline-flex size-7 items-center justify-center rounded-full transition-colors hover:bg-primary/15"
                aria-label={`Remove ${s}`}
                onClick={() => onChange(value.filter((x) => x !== s))}
              >
                <X aria-hidden size={12} weight="bold" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="rounded-lg border border-dashed border-border-strong px-3 py-2 text-sm text-muted">No skills listed yet.</p>
      )}
      <div className="flex gap-2">
        <Input
          id="skills"
          list={listId}
          value={draft}
          maxLength={120}
          placeholder="Type a skill, e.g. Soldering"
          aria-describedby="skills-hint"
          disabled={value.length >= SKILL_MAX}
          onChange={(e) => {
            setDraft(e.target.value);
            setLocalError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button variant="secondary" onClick={add} disabled={!draft.trim() || value.length >= SKILL_MAX}>
          Add
        </Button>
      </div>
      <datalist id={listId}>
        {options.map((s) => (
          <option key={s.id} value={s.name} />
        ))}
      </datalist>
      <p id="skills-hint" className="text-xs text-muted">
        {value.length} / {SKILL_MAX} skills. Press Enter to add; pick a suggestion or type your own.
      </p>
      {(localError || error) && (
        <p className="text-xs font-medium text-danger" role="alert">
          {localError || error}
        </p>
      )}
    </div>
  );
}

const FIELD_KEYS = ["skills", "career_interest", "background"] as const;

function ProfileForm({ me }: { me: TraineeMe }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [formError, setFormError] = useState<unknown>(null);
  const form = useForm<ProfileValues>({
    resolver: zodResolver(profileSchema),
    defaultValues: {
      skills: me.skills.map((s) => s.name),
      career_interest: me.career_interest ?? "",
      background: me.background ?? "",
    },
  });
  const { register, handleSubmit, setValue, watch, setError, formState } = form;
  const skills = watch("skills");
  const career = watch("career_interest");
  const background = watch("background");

  const save = useMutation({
    mutationFn: (v: ProfileValues) => call(api.PATCH("/api/v1/trainees/me", { body: profileBody(v) })),
    onSuccess: async (_res, v) => {
      toast.success("Profile saved");
      form.reset({ ...profileBody(v) });
      await Promise.all([
        qc.invalidateQueries({ queryKey: qk.trainees.all() }),
        qc.invalidateQueries({ queryKey: qk.skills.list() }),
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
    <Card title="About you" description="You can edit these. They shape your project suggestions." icon={<NotePencil />}>
      <form
        noValidate
        className="flex flex-col gap-4"
        onSubmit={handleSubmit((v) => {
          setFormError(null);
          save.mutate(v);
        })}
      >
        <FormField label="Skills" htmlFor="skills" error={formState.errors.skills?.message ?? formState.errors.skills?.[0]?.message}>
          <SkillsInput value={skills} onChange={(v) => setValue("skills", v, { shouldDirty: true, shouldValidate: true })} />
        </FormField>
        <FormField
          label="Career interest"
          htmlFor="career_interest"
          error={formState.errors.career_interest?.message}
          hint={`${career.length} / ${CAREER_MAX}`}
        >
          <Input id="career_interest" maxLength={CAREER_MAX} placeholder="e.g. Solar installation technician" {...register("career_interest")} />
        </FormField>
        <FormField
          label="Background"
          htmlFor="background"
          error={formState.errors.background?.message}
          hint={`${background.length} / ${BACKGROUND_MAX}`}
        >
          <Textarea id="background" rows={5} maxLength={BACKGROUND_MAX} placeholder="Prior work, hobbies, projects you have done…" {...register("background")} />
        </FormField>
        <FormError error={formError} />
        <div className="flex flex-col gap-3 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-xs text-muted">Changes are used the next time the programme team generates recommendations.</p>
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

/** Fields owned by the programme team (read-only for the trainee). Gender is never shown here. */
function ManagedRecord({ me }: { me: TraineeMe }) {
  const scores = [["Theory", me.scores.theory], ["Practical", me.scores.practical], ["Safety compliance", me.scores.safety]] as const;
  return (
    <Card
      title="Programme record"
      description="Trade, trainee code, centre and assessment scores are managed by the programme team. Ask your coordinator if something is wrong."
      icon={<LockKey />}
    >
      <div className="flex items-center gap-3 rounded-lg bg-surface-2 p-3">
        <Avatar name={me.full_name} />
        <div className="min-w-0">
          <p className="font-semibold text-text [overflow-wrap:anywhere]">{me.full_name}</p>
          <p className="flex items-center gap-1 text-xs text-muted">
            <IdentificationCard aria-hidden size={14} />
            {me.trainee_code}
          </p>
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4">
        <Fact label="Trade">{me.trade.name}</Fact>
        <Fact label="Training centre">{me.centre_name ?? "—"}</Fact>
        <div className="col-span-2">
          <Fact label="Assessment"><StatusBadge kind="assessment" value={me.assessment_status} /></Fact>
        </div>
      </dl>
      <h3 className="mt-5 mb-3 text-xs font-semibold tracking-wide text-muted uppercase">Assessment scores</h3>
      <dl className="flex flex-col gap-3">
        {scores.map(([k, v]) => (
          <div key={k} className="flex flex-wrap items-center justify-between gap-2">
            <dt className="text-sm text-muted">{k}</dt>
            <dd><ScoreBar value={v} label={k} tone="auto" /></dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

export function ProfilePage() {
  const { me } = useStudentContext();
  if (!me) return <LoadingState />;
  return (
    <div className="space-y-6">
      <PageHeader title="My profile" description="Keep your skills and interests current so suggestions fit you better." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] lg:items-start">
        <ManagedRecord me={me} />
        <div className="min-w-0 space-y-6">
          <ProfileForm key={me.updated_at} me={me} />
          <ResumePanel me={me} />
        </div>
      </div>
    </div>
  );
}
