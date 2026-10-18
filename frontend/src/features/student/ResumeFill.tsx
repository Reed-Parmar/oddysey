/**
 * Onboarding: read a resume and pre-fill skills and career interest (ONB-04, ADR-024). The file is not stored and
 * nothing is saved until the student presses Save progress or Finish.
 */
import { CheckCircle, Sparkle, WarningCircle } from "@phosphor-icons/react";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { ApiError, errorMessage } from "@/api/errors";
import type { ResumeSuggestions } from "@/api/types";
import { uploadMultipart } from "@/api/upload";
import { Alert } from "@/components/ui";

import { resumeFileError, resumeUploadMessage } from "./forms";
import { DropZone } from "./ResumePanel";

export function ResumeFill({ onFill }: { onFill: (s: ResumeSuggestions) => { skillsAdded: number; interestFilled: boolean } }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const read = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append("file", file);
      return uploadMultipart<{ data: ResumeSuggestions }>("/onboarding/resume-suggestions", form);
    },
    onSuccess: (res, file) => {
      const s = res.data;
      if (s.status !== "extracted" || (!s.skills.length && !s.career_interest)) {
        setProblem("We couldn't find skills in that resume. Add them below yourself.");
        return;
      }
      const { skillsAdded, interestFilled } = onFill(s);
      const parts = [skillsAdded ? `${skillsAdded} skill${skillsAdded === 1 ? "" : "s"}` : null, interestFilled ? "your career interest" : null].filter(Boolean);
      setDone(parts.length ? `Filled ${parts.join(" and ")} from ${file.name}. Review them below, then save.` : `Read ${file.name}; everything it lists is already filled in.`);
    },
    onError: (e) => setProblem(e instanceof ApiError ? resumeUploadMessage(e.status, e.code, errorMessage(e)) : errorMessage(e)),
  });

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-linear-to-br from-primary-soft to-accent-soft p-4">
      <p className="flex items-center gap-2 text-sm font-semibold text-text">
        <Sparkle aria-hidden size={16} weight="fill" className="text-accent" />
        Fill skills and interest from your resume
      </p>
      <p className="-mt-1 text-xs text-muted">
        Optional. We read your PDF or DOCX resume and fill the fields below; you can change anything. The file is not kept.
      </p>
      <DropZone
        disabled={read.isPending}
        onFile={(f) => {
          setProblem(null);
          setDone(null);
          const err = resumeFileError(f);
          if (err) setProblem(err);
          else read.mutate(f);
        }}
      />
      {read.isPending && <p role="status" className="text-sm text-muted">Reading your resume…</p>}
      {done && <Alert variant="success" icon={<CheckCircle />}>{done}</Alert>}
      {problem && <Alert variant="warning" icon={<WarningCircle />}>{problem}</Alert>}
    </div>
  );
}
