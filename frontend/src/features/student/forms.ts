/** Client-side form rules for the student module (UX only; the server is authoritative, student.md §9.1). */
import { z } from "zod";

import type { Cycle, HistoryEntry, OnboardingData, Resume, Submission, TraineeMe } from "@/api/types";

// ---------------------------------------------------------------- resume (RES-01, ADR-015)

export const RESUME_MAX_BYTES = 5 * 1024 * 1024;
export const RESUME_ACCEPT = ".pdf,.docx";

/** Client-side pre-check (the server re-checks size, extension and file signature). */
export function resumeFileError(file: { name: string; size: number }): string | null {
  const ext = file.name.toLowerCase().split(".").pop();
  if (!file.name.includes(".") || (ext !== "pdf" && ext !== "docx")) return "Upload a PDF or DOCX";
  if (file.size === 0) return "This file is empty";
  if (file.size > RESUME_MAX_BYTES) return "Resume must be 5 MB or smaller";
  return null;
}

/** student.md §3.3a error copy; anything else falls back to the server message. */
export function resumeUploadMessage(status: number, code: string, fallback: string): string {
  if (status === 413) return "Resume must be 5 MB or smaller";
  if (status === 415) return "Upload a PDF or DOCX";
  if (code === "RATE_LIMITED") return "Too many uploads. Try again in an hour.";
  return fallback;
}

/** Current skills plus the chosen suggestions, de-duplicated; null when the total would exceed SKILL_MAX. */
export function mergeSkills(current: string[], add: string[]): string[] | null {
  const merged = normaliseSkills([...current, ...add]);
  return merged.length > SKILL_MAX ? null : merged;
}

// ---------------------------------------------------------------- profile (TRN-02)

export const SKILL_MAX = 20;
export const SKILL_NAME_MAX = 80;
export const CAREER_MAX = 300;
export const BACKGROUND_MAX = 2000;
export const TRADE_MIN = 1;
export const TRADE_MAX = 5;

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

const skillsField = z
  .array(z.string().trim().min(1, "Skill names cannot be empty").max(SKILL_NAME_MAX, `At most ${SKILL_NAME_MAX} characters per skill`))
  .max(SKILL_MAX, `At most ${SKILL_MAX} skills`);

export const profileSchema = z.object({
  trade_ids: z.array(z.string()).min(TRADE_MIN, "Select at least one ITI trade").max(TRADE_MAX, `Select at most ${TRADE_MAX} trades`),
  skills: skillsField,
  career_interest: z.string().max(CAREER_MAX, `At most ${CAREER_MAX} characters`),
  background: z.string().max(BACKGROUND_MAX, `At most ${BACKGROUND_MAX} characters`),
});
export type ProfileValues = z.infer<typeof profileSchema>;

/** The exact self-editable TRN-02 body: these four keys only (code, centre and marks are programme-managed). */
export function profileBody(v: ProfileValues) {
  return {
    trade_ids: [...new Set(v.trade_ids)],
    skills: normaliseSkills(v.skills),
    career_interest: v.career_interest.trim(),
    background: v.background.trim(),
  };
}

// ---------------------------------------------------------------- onboarding (ADR-017)

export const GENDER_OPTIONS = [
  ["female", "Female"],
  ["male", "Male"],
  ["other", "Other"],
  ["undisclosed", "Prefer not to say"],
] as const;
export const TRAINEE_CODE_PATTERN = /^[A-Za-z0-9-]{1,40}$/;
export const NAME_MAX = 120;
export const CENTRE_MAX = 120;

export const onboardingSchema = z.object({
  full_name: z.string().max(NAME_MAX, `At most ${NAME_MAX} characters`),
  gender: z.string().refine((v) => v === "" || GENDER_OPTIONS.some(([g]) => g === v), "Choose one of the options"),
  trainee_code: z
    .string()
    .trim()
    .refine((v) => v === "" || TRAINEE_CODE_PATTERN.test(v), "Use letters, numbers and hyphens only (up to 40 characters)"),
  centre_name: z.string().max(CENTRE_MAX, `At most ${CENTRE_MAX} characters`),
  trade_ids: z.array(z.string()).max(TRADE_MAX, `Select at most ${TRADE_MAX} trades`),
  skills: skillsField,
  career_interest: z.string().max(CAREER_MAX, `At most ${CAREER_MAX} characters`),
  background: z.string().max(BACKGROUND_MAX, `At most ${BACKGROUND_MAX} characters`),
  /** ADR-018: "" = automatic (the cycle that best matches the student's trades). */
  cycle_id: z.string(),
});
export type OnboardingValues = z.infer<typeof onboardingSchema>;
export type OnboardingField = keyof OnboardingValues;
export const ONBOARDING_FIELDS = Object.keys(onboardingSchema.shape) as OnboardingField[];

const str = (v: unknown) => (typeof v === "string" ? v : "");
const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Saved draft (an untyped dict on the wire) → form values. Unknown shapes fall back to empty fields. */
export function onboardingValues(data: Record<string, unknown> | null | undefined): OnboardingValues {
  const d = data ?? {};
  return {
    full_name: str(d.full_name),
    gender: str(d.gender),
    trainee_code: str(d.trainee_code),
    centre_name: str(d.centre_name),
    trade_ids: strList(d.trade_ids),
    skills: strList(d.skills),
    career_interest: str(d.career_interest),
    background: str(d.background),
    cycle_id: str(d.cycle_id),
  };
}

/** PUT /onboarding body; empty optional text becomes null. */
export function onboardingBody(v: OnboardingValues): OnboardingData {
  const t = (x: string) => x.trim() || null;
  return {
    full_name: t(v.full_name),
    gender: v.gender || null,
    trainee_code: t(v.trainee_code),
    centre_name: t(v.centre_name),
    trade_ids: [...new Set(v.trade_ids)],
    skills: normaliseSkills(v.skills),
    career_interest: t(v.career_interest),
    background: t(v.background),
    cycle_id: v.cycle_id || null,
  };
}

/** Required fields still empty: mirrors the server's `missing()` (the server stays authoritative). */
export function onboardingMissing(v: OnboardingValues): OnboardingField[] {
  const out: OnboardingField[] = [];
  if (!v.full_name.trim()) out.push("full_name");
  if (!v.gender) out.push("gender");
  if (!v.trainee_code.trim()) out.push("trainee_code");
  if (!v.trade_ids.length) out.push("trade_ids");
  if (!normaliseSkills(v.skills).length) out.push("skills");
  if (!v.career_interest.trim()) out.push("career_interest");
  return out;
}

export const ONBOARDING_REQUIRED_TEXT: Partial<Record<OnboardingField, string>> = {
  full_name: "Enter your full name",
  gender: "Choose an option (\"Prefer not to say\" is fine)",
  trainee_code: "Enter your trainee ID",
  trade_ids: "Select at least one ITI trade",
  skills: "Add at least one skill",
  career_interest: "Tell us your career interest",
};

export const ONBOARDING_SECTIONS: { key: string; label: string; fields: OnboardingField[] }[] = [
  { key: "identity", label: "About you", fields: ["full_name", "gender", "trainee_code"] },
  { key: "training", label: "Training", fields: ["trade_ids"] },
  { key: "skills", label: "Skills and interests", fields: ["skills", "career_interest"] },
];

// ---------------------------------------------------------------- resume-reported marks (ADR-017)

export const MARK_FIELDS = [
  ["theory", "Theory"],
  ["practical", "Practical"],
  ["safety", "Safety compliance"],
] as const;
export type MarkField = (typeof MARK_FIELDS)[number][0];
export type MarkValues = Record<MarkField, string>;

export function markError(v: string): string | null {
  const s = v.trim();
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || n > 100) return "Enter a number from 0 to 100";
  return null;
}

/** Reads one saved, unverified mark from `me.reported_scores` (an untyped dict on the wire). */
export function reportedValue(saved: TraineeMe["reported_scores"], field: MarkField): number | null {
  const entry = saved?.[field] as { value?: unknown } | undefined;
  return typeof entry?.value === "number" ? entry.value : null;
}

/** Initial values: the trainee's saved confirmation for this resume, else the numbers found in it. */
export function initialMarks(resume: Resume, saved: TraineeMe["reported_scores"]): MarkValues {
  const sameResume = !!saved && saved.resume_id === resume.id;
  const found = new Map((resume.extracted?.assessment_marks ?? []).map((m) => [m.field, m.value]));
  const out = { theory: "", practical: "", safety: "" } as MarkValues;
  for (const [f] of MARK_FIELDS) {
    const v = (sameResume ? reportedValue(saved, f) : null) ?? found.get(f) ?? null;
    out[f] = v == null ? "" : String(v);
  }
  return out;
}

export function reportedScoresBody(resumeId: string, v: MarkValues) {
  const n = (s: string) => (s.trim() === "" ? null : Number(s));
  return { reported_scores: { resume_id: resumeId, theory: n(v.theory), practical: n(v.practical), safety: n(v.safety) } };
}

// ---------------------------------------------------------------- rejection (ADR-017)

export const REJECT_MIN = 10;
export const REJECT_MAX = 500;

export function rejectReasonError(reason: string): string | null {
  const r = reason.trim();
  if (r.length < REJECT_MIN) return `Give a reason of at least ${REJECT_MIN} characters`;
  if (r.length > REJECT_MAX) return `At most ${REJECT_MAX} characters`;
  return null;
}

/** One key per dialog opening; reused on retry so a replay returns the stored result. */
export const newIdempotencyKey = () => crypto.randomUUID().replace(/-/g, "");

export const REJECT_CONFLICT_TEXT: Record<string, string> = {
  REJECTION_NOT_ALLOWED_AFTER_SUBMISSION:
    "You have already submitted work for this project, so it can no longer be rejected. Talk to your supervisor.",
  ALLOCATION_REJECTED: "You have already rejected this project. A different eligible project will be found automatically.",
  CYCLE_CLOSED: "This programme cycle is closed, so projects can no longer be rejected.",
};

// ---------------------------------------------------------------- submission (SUB-01)

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const ALLOWED_EXT = ["pdf", "docx", "pptx", "zip", "png", "jpg", "jpeg"] as const;
export const REPORT_EXT = ["pdf", "docx"] as const;
export const FILE_ACCEPT = ALLOWED_EXT.map((e) => `.${e}`).join(",");
export const REPORT_REQUIRED = "Add your report: a report link or a PDF/DOCX report file. A video alone is not enough.";

const fileExt = (name: string) => (name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "");
export const isReportFile = (f: { name: string } | null | undefined) => !!f && (REPORT_EXT as readonly string[]).includes(fileExt(f.name));

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
      .refine((f) => !f || (ALLOWED_EXT as readonly string[]).includes(fileExt(f.name)),
        `Allowed file types: ${ALLOWED_EXT.join(", ")}`),
    logbook_hours: numberField(0, 1000, "Logbook hours"),
    bom_cost_inr: numberField(0, 10_000_000, "Bill of materials cost"),
    note: z.string().max(2000, "Notes can be at most 2000 characters"),
  })
  .superRefine((v, ctx) => {
    // A report is required: a report link, or a PDF/DOCX file. Other files are supplements only (server: REPORT_REQUIRED).
    if (!v.report_url.trim() && !isReportFile(v.file))
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["root"], message: REPORT_REQUIRED });
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
  if (!cycle) return "No programme cycle is open";
  if (cycle.status === "archived") return "This cycle is archived. Submissions are closed and your work is kept read-only.";
  if (!me?.allocation) return "You have no allocated project yet";
  if (latest?.status === "submitted")
    return `Version ${latest.version} is awaiting evaluation. You can submit again only if rework is requested.`;
  if (latest?.status === "evaluated") return "Your project has been evaluated. The evaluation is final; no further versions are accepted.";
  return null;
}

/** The trainee may reject only an active allocation with no submissions, while the cycle is open (UX only). */
export function canReject(cycle: Cycle | null, me: TraineeMe | null, versionsForAllocation: number): boolean {
  return !!cycle && cycle.status !== "archived" && me?.allocation?.status === "active" && versionsForAllocation === 0;
}

/** The newest history entry the trainee rejected (drives the "finding a different project" copy). */
export function lastRejected(history: HistoryEntry[] | undefined): HistoryEntry | undefined {
  return (history ?? [])
    .filter((h) => h.allocation.status === "rejected")
    .sort((a, b) => (b.rejected_at ?? "").localeCompare(a.rejected_at ?? ""))[0];
}

export const WAITING_TEXT = "We're finding a suitable project for you. Allocation runs automatically (about every 15 minutes).";
export const WAITING_AFTER_REJECT_TEXT =
  "Finding a different eligible project for you. Allocation runs automatically (about every 15 minutes); the project you rejected will not be allocated to you again.";

// ---------------------------------------------------------------- dashboard next step (student.md §3.2)

export type NextStep = { text: string; to?: string; cta?: string };

const fmtDate = (iso: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));

export function nextStep(
  cycle: Cycle | null,
  me: TraineeMe | null,
  latest: Submission | undefined,
  opts: { deadline?: string | null; rejectedBefore?: boolean } = {},
): NextStep {
  if (!cycle) return { text: "No active programme cycle" };
  if (cycle.status === "archived")
    return { text: "This cycle is archived. Your project and results are kept read-only.", to: "/student/project", cta: "View my project" };
  if (!me?.allocation) return { text: opts.rejectedBefore ? WAITING_AFTER_REJECT_TEXT : WAITING_TEXT };
  switch (latest?.status) {
    case "submitted":
      return { text: `Version ${latest.version} is being evaluated`, to: "/student/submissions", cta: "View my submission" };
    case "rework_requested":
      return { text: "Rework requested: read the feedback and submit a new version", to: "/student/submissions", cta: "Submit a new version" };
    case "evaluated": {
      const grade = latest.evaluation?.grade ?? latest.report_evaluation?.effective_grade ?? latest.report_evaluation?.grade;
      return { text: grade ? `Evaluated: grade ${grade}` : "Your project has been evaluated", to: `/student/submissions/${latest.id}`, cta: "View evaluation" };
    }
    default:
      return {
        text: `Read your project brief and submit your report before ${fmtDate(opts.deadline ?? cycle.submission_deadline)}`,
        to: "/student/submissions",
        cta: "Submit my report",
      };
  }
}
