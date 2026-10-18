/** Resume panel on the Profile page (ADR-024; student.md §3.3a, RES-01/02/04). Suggestions only: nothing is applied until saved via TRN-02. */
import { ArrowClockwise, Check, FileArrowUp, FileText, Plus, Sparkle, WarningCircle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState, type DragEvent } from "react";

import { api, call } from "@/api/client";
import { ApiError, errorMessage } from "@/api/errors";
import { qk } from "@/api/queryKeys";
import type { Resume, TraineeMe } from "@/api/types";
import { uploadMultipart } from "@/api/upload";
import { DateTime, ErrorState, Skeleton, useToast } from "@/components/shared";
import { Alert, Button, Card, cx } from "@/components/ui";
import { RESUME_SOURCE_LABEL, ResumeDownloadButton, ResumeExtractionView } from "@/features/shared/views";

import { RESUME_ACCEPT, SKILL_MAX, mergeSkills, resumeFileError, resumeUploadMessage } from "./forms";
import { useMyResume } from "./hooks";

type ResumeEnvelope = { data: Resume | null };

export function DropZone({ disabled, onFile }: { disabled: boolean; onFile: (f: File) => void }) {
  const inputId = useId();
  const [over, setOver] = useState(false);
  const pick = (f: File | undefined) => f && !disabled && onFile(f);
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    pick(e.dataTransfer.files?.[0]);
  };
  return (
    <label
      htmlFor={inputId}
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cx(
        "flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors",
        over ? "border-primary bg-primary-soft" : "border-border-strong bg-surface-2 hover:border-primary",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <FileArrowUp aria-hidden size={28} className="text-primary" />
      <span className="text-sm font-semibold text-text">Drag your resume here, or <span className="text-primary underline">browse</span></span>
      <span className="text-xs text-muted">PDF or DOCX, up to 5 MB</span>
      <input
        id={inputId}
        type="file"
        accept={RESUME_ACCEPT}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          pick(e.target.files?.[0]);
          e.target.value = "";
        }}
      />
    </label>
  );
}

function UploadProgress({ fraction }: { fraction: number }) {
  const pct = Math.round(fraction * 100);
  const reading = pct >= 100;
  return (
    <div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-bg" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Upload progress">
        <div className={cx("h-full bg-primary transition-[width]", reading && "animate-pulse")} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted" aria-live="polite">
        {reading ? "Reading your resume… this can take a few seconds." : `Uploading… ${pct}%`}
      </p>
    </div>
  );
}

function saveLabel(skills: number, interest: boolean) {
  if (skills && interest) return `Save ${skills} skill${skills === 1 ? "" : "s"} and career interest`;
  if (interest) return "Save career interest";
  return `Save selected skills${skills ? ` (${skills})` : ""}`;
}

/**
 * Suggested skills as toggle chips (ADR-024): new skills from the resume start selected and an empty career interest
 * is filled from the resume, so one click saves them. Nothing changes until the student saves (TRN-02, ADR-015).
 */
function SkillSuggestions({ resume, me }: { resume: Resume; me: TraineeMe }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  useEffect(() => {
    const fresh = resume.skill_matches.filter((m) => !m.already_on_profile).map((m) => m.name);
    setChosen(new Set(fresh.slice(0, Math.max(0, SKILL_MAX - me.skills.length))));
    // Pre-select once per resume; later profile edits don't reset the student's choices.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume.id]);

  const current = me.skills.map((s) => s.name);
  const merged = mergeSkills(current, [...chosen]);
  const hint = resume.extracted?.career_interest_hint ?? null;
  const fillInterest = !!hint && !me.career_interest?.trim();

  /** TRN-02 with the server response written straight into the cache; suggestion chips update optimistically. */
  const save = useMutation({
    mutationFn: (body: { skills?: string[]; career_interest?: string }) => call(api.PATCH("/api/v1/trainees/me", { body })),
    onMutate: async (body) => {
      if (!body.skills) return { previous: undefined };
      await qc.cancelQueries({ queryKey: qk.resumes.me() });
      const previous = qc.getQueryData<ResumeEnvelope>(qk.resumes.me());
      const added = new Set(body.skills.map((s) => s.toLowerCase()));
      qc.setQueryData<ResumeEnvelope>(qk.resumes.me(), (old) => old?.data ? {
        data: { ...old.data, skill_matches: old.data.skill_matches.map((m) => ({ ...m, already_on_profile: m.already_on_profile || added.has(m.name.toLowerCase()) })) },
      } : old);
      return { previous };
    },
    onSuccess: (_res, body) => {
      setChosen(new Set());
      toast.success(body.skills ? "Saved to your profile" : "Career interest updated");
    },
    onError: (e, _body, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.resumes.me(), ctx.previous);
      toast.error(errorMessage(e));
    },
    onSettled: () => Promise.all([
      qc.invalidateQueries({ queryKey: qk.trainees.me() }),
      qc.invalidateQueries({ queryKey: qk.resumes.all() }),
      qc.invalidateQueries({ queryKey: qk.skills.all() }),
    ]),
  });

  if (!resume.skill_matches.length) return <span className="text-sm text-muted">None found</span>;
  return (
    <div className="flex flex-col gap-3">
      <ul className="flex flex-wrap gap-1.5" aria-label="Suggested skills">
        {resume.skill_matches.map((m) => {
          const on = m.already_on_profile || chosen.has(m.name);
          return (
            <li key={m.name.toLowerCase()}>
              <button
                type="button"
                aria-pressed={on}
                disabled={m.already_on_profile || save.isPending}
                title={m.already_on_profile ? "Already on your profile" : m.known_skill ? "A skill used by projects in this programme" : undefined}
                onClick={() => setChosen((prev) => {
                  const next = new Set(prev);
                  if (next.has(m.name)) next.delete(m.name);
                  else next.add(m.name);
                  return next;
                })}
                className={cx(
                  "inline-flex min-h-8 items-center gap-1 rounded-full border px-3 text-sm font-medium transition-colors disabled:cursor-default",
                  on ? "border-primary bg-primary-soft text-primary-ink" : "border-border-strong bg-surface text-text hover:border-primary",
                )}
              >
                {on ? <Check aria-hidden size={12} weight="bold" /> : <Plus aria-hidden size={12} weight="bold" />}
                {m.name}
                {m.known_skill && <span className="rounded bg-accent-soft px-1 text-[10px] font-semibold text-accent-ink">Programme skill</span>}
              </button>
            </li>
          );
        })}
      </ul>
      {fillInterest && (
        <p className="text-sm text-muted">
          Career interest from your resume: <span className="font-medium text-text">{hint}</span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          icon={<Plus />}
          loading={save.isPending && (!!chosen.size || fillInterest)}
          disabled={(!chosen.size && !fillInterest) || !merged || save.isPending}
          onClick={() => merged && save.mutate({
            ...(chosen.size ? { skills: merged } : {}),
            ...(fillInterest && hint ? { career_interest: hint.slice(0, 300) } : {}),
          })}
        >
          {saveLabel(chosen.size, fillInterest)}
        </Button>
        {hint && !fillInterest && (
          <Button
            size="sm"
            variant="secondary"
            disabled={save.isPending || me.career_interest === hint.slice(0, 300)}
            onClick={() => save.mutate({ career_interest: hint.slice(0, 300) })}
          >
            Use as career interest
          </Button>
        )}
      </div>
      {!merged && (
        <p className="text-xs font-medium text-danger" role="alert">
          You can list at most {SKILL_MAX} skills. Remove some on the form, or choose fewer.
        </p>
      )}
    </div>
  );
}

export function ResumePanel({ me }: { me: TraineeMe }) {
  const qc = useQueryClient();
  const toast = useToast();
  const resumeQ = useMyResume();
  const [progress, setProgress] = useState<number | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const lastFile = useRef<File | null>(null);

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      setProgress(0);
      return uploadMultipart<{ data: Resume }>("/trainees/me/resumes", form, { onProgress: setProgress });
    },
    onSuccess: (res) => {
      qc.setQueryData<ResumeEnvelope>(qk.resumes.me(), { data: res.data });
      void qc.invalidateQueries({ queryKey: qk.resumes.all(), refetchType: "none" });
      setProblem(null);
      if (res.data.status === "extracted") toast.success("Resume read: review the suggestions below");
      else toast.error("We could not read text from this resume");
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        if (e.code === "NO_ACTIVE_CYCLE") void qc.invalidateQueries({ queryKey: qk.cycles.current() });
        if (e.code === "NO_TRAINEE_RECORD") void qc.invalidateQueries({ queryKey: qk.trainees.me() });
        setProblem(resumeUploadMessage(e.status, e.code, errorMessage(e)));
      } else setProblem(errorMessage(e));
    },
    onSettled: () => setProgress(null),
  });

  const start = (file: File) => {
    const err = resumeFileError(file);
    if (err) {
      lastFile.current = null;
      setProblem(err);
      return;
    }
    lastFile.current = file;
    upload.mutate(file);
  };

  const r = resumeQ.data?.data ?? null;
  return (
    <Card
      title="Update resume"
      icon={<FileText />}
      description="Upload your resume and we will suggest skills (and read any ITI marks it lists). These are suggestions only: nothing changes on your profile until you choose to add it."
      actions={r ? <ResumeDownloadButton resume={r} /> : undefined}
    >
      <div className="flex flex-col gap-4">
        {resumeQ.isLoading ? (
          <div className="space-y-2"><Skeleton className="h-5 w-1/2" /><Skeleton className="h-24 w-full" /></div>
        ) : resumeQ.error ? (
          <ErrorState error={resumeQ.error} onRetry={() => void resumeQ.refetch()} />
        ) : r ? (
          <div className="flex flex-col gap-3">
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>Uploaded <DateTime value={r.created_at} /></span>
              {r.source && (
                <span className="inline-flex items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 font-semibold text-accent-ink">
                  {r.source === "ai" && <Sparkle aria-hidden size={10} weight="fill" />}
                  {RESUME_SOURCE_LABEL[r.source]}
                </span>
              )}
            </p>
            {r.status === "failed" && (
              <Alert variant="warning" icon={<WarningCircle />}>
                {r.error_code === "no_text"
                  ? "We couldn't read text from this file. Upload a text-based PDF or a DOCX (not a scan)."
                  : "This file couldn't be opened. Try saving it again as PDF."}
              </Alert>
            )}
            {r.status === "extracted" && (
              <ResumeExtractionView resume={r} skills={<SkillSuggestions resume={r} me={me} />} />
            )}
          </div>
        ) : (
          <p className="text-sm text-muted">Upload your resume to get skill suggestions for your profile.</p>
        )}

        {progress != null ? <UploadProgress fraction={progress} /> : (
          <DropZone disabled={upload.isPending} onFile={start} />
        )}
        {r && progress == null && <p className="-mt-2 text-xs text-muted">Uploading again replaces the current suggestions; earlier versions are kept for the programme team.</p>}
        {problem && (
          <Alert variant="danger" icon={<WarningCircle />}>
            <span>{problem}</span>
            {lastFile.current && !resumeFileError(lastFile.current) && (
              <Button size="sm" variant="secondary" className="mt-2" icon={<ArrowClockwise />} loading={upload.isPending}
                onClick={() => lastFile.current && upload.mutate(lastFile.current)}>
                Try again
              </Button>
            )}
          </Alert>
        )}
      </div>
    </Card>
  );
}
