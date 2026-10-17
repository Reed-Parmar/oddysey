/** Client-side form rules for the student module (UX only; the server is authoritative, student.md §9.1). */
import { z } from "zod";

import type { Cycle, ProgressRow, Submission, TraineeMe } from "@/api/types";

// ---------------------------------------------------------------- profile (TRN-02)

export const SKILL_MAX = 20;
export const SKILL_NAME_MAX = 80;
export const CAREER_MAX = 300;
export const BACKGROUND_MAX = 2000;

/** Trims, drops empties and case-insensitive duplicates (first spelling wins). */
export function normaliseSkills(names: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = raw.trim().replace(/\s+/g, " ");
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/** Why a skill cannot be added, or null when it can. */
export function skillAddError(current: string[], candidate: string): string | null {
  const name = candidate.trim();
  if (!name) return "Enter a skill name";
  if (name.length > SKILL_NAME_MAX) return `Skill names can be at most ${SKILL_NAME_MAX} characters`;
  if (current.some((s) => s.toLowerCase() === name.toLowerCase())) return "This skill is already listed";
  if (current.length >= SKILL_MAX) return `You can list at most ${SKILL_MAX} skills`;
  return null;
}

export const profileSchema = z.object({
  skills: z
    .array(z.string().trim().min(1, "Skill names cannot be empty").max(SKILL_NAME_MAX, `At most ${SKILL_NAME_MAX} characters per skill`))
    .max(SKILL_MAX, `At most ${SKILL_MAX} skills`),
  career_interest: z.string().max(CAREER_MAX, `At most ${CAREER_MAX} characters`),
  background: z.string().max(BACKGROUND_MAX, `At most ${BACKGROUND_MAX} characters`),
});
export type ProfileValues = z.infer<typeof profileSchema>;

/** The exact TRN-02 body: only these three keys, ever. */
export function profileBody(v: ProfileValues) {
  return {
    skills: normaliseSkills(v.skills),
    career_interest: v.career_interest.trim(),
    background: v.background.trim(),
  };
}

// ---------------------------------------------------------------- submission (SUB-01)

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_EXT = ["pdf", "docx", "pptx", "zip", "png", "jpg", "jpeg"] as const;
export const FILE_ACCEPT = ALLOWED_EXT.map((e) => `.${e}`).join(",");
export const ARTIFACT_REQUIRED = "Provide at least one of: video link, report link, report file.";

export function isHttpsUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !!u.hostname;
  } catch {
    return false;
  }
}

const httpsField = z
  .string()
  .trim()
  .max(2048, "Links can be at most 2048 characters")
  .refine((v) => v === "" || isHttpsUrl(v), "Enter a full link starting with https://");

const numberField = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .refine((v) => v === "" || (Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max),
      `${label} must be a number from ${min.toLocaleString("en-IN")} to ${max.toLocaleString("en-IN")}`);

export const submissionSchema = z
  .object({
    video_url: httpsField,
    report_url: httpsField,
    file: z
      .custom<File | null>((v) => v === null || v instanceof File)
      .refine((f) => !f || f.size <= MAX_FILE_BYTES, "File must be 10 MB or smaller")
      .refine((f) => !f || (ALLOWED_EXT as readonly string[]).includes(f.name.split(".").pop()?.toLowerCase() ?? ""),
        `Allowed file types: ${ALLOWED_EXT.join(", ")}`),
    logbook_hours: numberField(0, 1000, "Logbook hours"),
    bom_cost_inr: numberField(0, 10_000_000, "Bill of materials cost"),
    note: z.string().max(2000, "Notes can be at most 2000 characters"),
  })
  .superRefine((v, ctx) => {
    if (!v.video_url.trim() && !v.report_url.trim() && !v.file)
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["root"], message: ARTIFACT_REQUIRED });
  });
export type SubmissionValues = z.infer<typeof submissionSchema>;

export const emptySubmission: SubmissionValues = {
  video_url: "", report_url: "", file: null, logbook_hours: "", bom_cost_inr: "", note: "",
};

/** Multipart body for SUB-01: only non-empty fields are appended (student.md §3.7). */
export function buildSubmissionFormData(v: SubmissionValues): FormData {
  const fd = new FormData();
  for (const key of ["video_url", "report_url", "logbook_hours", "bom_cost_inr", "note"] as const) {
    const val = v[key].trim();
    if (val) fd.append(key, val);
  }
  if (v.file) fd.append("file", v.file);
  return fd;
}

/** Why the submit form is unavailable, or null when it is allowed (mirrors server guards; UX only). */
export function submitBlockedReason(cycle: Cycle | null, me: TraineeMe | null, latest: Submission | undefined): string | null {
  if (!cycle || cycle.status !== "published") return "Allocations are not published yet";
  if (!me?.allocation) return "You have no allocated project";
  if (latest?.status === "submitted") return `Version ${latest.version} is awaiting evaluation`;
  if (latest?.status === "evaluated") return "Your project has been evaluated. No further versions are accepted.";
  return null;
}

// ---------------------------------------------------------------- dashboard next step (student.md §3.2)

export type NextStep = { text: string; to?: string; cta?: string };

export function nextStep(cycle: Cycle | null, me: TraineeMe | null, row: ProgressRow | undefined): NextStep {
  if (!cycle) return { text: "No active cycle" };
  if (me?.assessment_status === "pending")
    return { text: "Keep your profile up to date; the programme team will add your scores", to: "/student/profile", cta: "Update my profile" };
  if (cycle.status === "draft")
    return { text: "See your suggested projects", to: "/student/recommendations", cta: "View suggestions" };
  if (!me?.allocation)
    return { text: "Allocations are published, but you have not been allocated yet. Contact your coordinator." };
  const sub = row?.latest_submission;
  switch (row?.progress) {
    case "submitted":
      return {
        text: sub ? `Version ${sub.version} is awaiting evaluation` : "Your latest version is awaiting evaluation",
        to: "/student/submission",
        cta: "View submission",
      };
    case "rework_requested":
      return { text: "Rework requested: read the feedback and submit a new version", to: "/student/submission", cta: "Submit a new version" };
    case "evaluated":
      return {
        text: `Evaluated: grade ${row.evaluation?.grade ?? "—"}`,
        to: sub ? `/student/submissions/${sub.id}` : "/student/submission",
        cta: "View evaluation",
      };
    default:
      return {
        text: `Submit your project work before ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(cycle.submission_deadline))}`,
        to: "/student/submission",
        cta: "Submit my work",
      };
  }
}
