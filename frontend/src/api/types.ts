/** Aliases over the generated OpenAPI schema (never hand-written duplicates; ADR-001). */
import type { components } from "./schema.gen";

type S = components["schemas"];

export type User = S["UserOut"];
export type AdminUser = S["AdminUser"];
export type Cycle = S["CycleOut"];
export type Trainee = S["TraineeOut"];
export type TraineeMe = S["TraineeMe"];
export type Project = S["ProjectOut"];
export type Recommendation = S["RecommendationOut"];
export type Factor = S["FactorOut"];
export type RecommendationRun = S["RunOut"];
export type Allocation = S["AllocationOut"];
export type AllocationRun = S["AllocationRunOut"];
export type Submission = S["SubmissionOut"];
export type Evaluation = S["EvaluationOut"];
export type ProgressRow = S["ProgressRow"];
export type Invitation = S["InvitationOut"];
export type ImportResult = S["ImportResult"];
export type Overview = S["Overview"];
export type NamedRef = S["NamedRef"];
export type PageMeta = S["PageMeta"];
export type ProjectCreate = S["ProjectCreate"];
export type ProjectPatch = S["ProjectPatch"];
export type TraineeAdminPatch = S["TraineeAdminPatch"];
export type EvaluationIn = S["EvaluationIn"];
export type Resume = S["ResumeOut"];

export type UserRole = User["role"];
