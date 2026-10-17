/** Rubric helpers for the evaluation form (supervisor.md §11). Preview only: the server computes the stored total/grade. */
import { z } from "zod";

import type { EvaluationIn } from "@/api/types";
import { CRITERIA } from "@/features/shared/views";

export type Grade = "A1" | "A" | "B+" | "B" | "C" | "D";
export type CriterionKey = (typeof CRITERIA)[number][0];
export type Outcome = EvaluationIn["outcome"];

/** Grade bands, identical to the DB generated column (supervisor.md §11.2). */
export function gradeFor(total: number): Grade {
  if (total >= 88) return "A1";
  if (total >= 80) return "A";
  if (total >= 75) return "B+";
  if (total >= 65) return "B";
  if (total >= 50) return "C";
  return "D";
}

export const FEEDBACK_MAX = 5000;
export const REWORK_FEEDBACK_MIN = 10;

export type EvaluationFormValues = {
  outcome: Outcome;
  scores: Record<CriterionKey, string>;
  feedback: string;
};

export const emptyEvaluationForm = (): EvaluationFormValues => ({
  outcome: "evaluated",
  scores: Object.fromEntries(CRITERIA.map(([k]) => [k, ""])) as Record<CriterionKey, string>,
  feedback: "",
});

/** Parses one score input. `null` = empty; `NaN` = not a whole number. */
export function parseScore(raw: string): number | null {
  const s = raw.trim();
  if (s === "") return null;
  return /^\d+$/.test(s) ? Number(s) : Number.NaN;
}

/** Sum of the five scores when every one is a valid in-range integer, else null. */
export function computeTotal(scores: Record<CriterionKey, string>): number | null {
  let total = 0;
  for (const [k, , max] of CRITERIA) {
    const n = parseScore(scores[k] ?? "");
    if (n === null || Number.isNaN(n) || n > max) return null;
    total += n;
  }
  return total;
}

/** Client-side (UX only) validation mirroring EVAL-01's server rules. */
export const evaluationFormSchema = z
  .object({
    outcome: z.enum(["evaluated", "rework_requested"]),
    scores: z.object(
      Object.fromEntries(CRITERIA.map(([k]) => [k, z.string()])) as Record<CriterionKey, z.ZodString>,
    ),
    feedback: z.string().max(FEEDBACK_MAX, `Feedback must be ${FEEDBACK_MAX} characters or fewer`),
  })
  .superRefine((v, ctx) => {
    for (const [k, , max] of CRITERIA) {
      const n = parseScore(v.scores[k]);
      if (n === null) {
        if (v.outcome === "evaluated") {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scores", k], message: "Required for a final evaluation" });
        }
      } else if (Number.isNaN(n) || n > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["scores", k], message: `Enter a whole number from 0 to ${max}` });
      }
    }
    if (v.outcome === "rework_requested" && v.feedback.trim().length < REWORK_FEEDBACK_MIN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["feedback"],
        message: `Explain what to rework (at least ${REWORK_FEEDBACK_MIN} characters)`,
      });
    }
  });

/** Builds the EVAL-01 body: empty scores omitted, `scores` omitted if none, `feedback` omitted if blank. */
export function toEvaluationBody(v: EvaluationFormValues): EvaluationIn {
  const scores: NonNullable<EvaluationIn["scores"]> = {};
  for (const [k] of CRITERIA) {
    const n = parseScore(v.scores[k]);
    if (n !== null && !Number.isNaN(n)) scores[k] = n;
  }
  const body: EvaluationIn = { outcome: v.outcome };
  if (Object.keys(scores).length) body.scores = scores;
  const fb = v.feedback.trim();
  if (fb) body.feedback = fb;
  return body;
}
