/** Aliases over the generated OpenAPI schema (never hand-written duplicates; ADR-001). */
import type { components } from "./schema.gen";

type S = components["schemas"];

export type User = S["UserOut"];
export type AdminUser = S["AdminUser"];
export type Cycle = S["CycleOut"];
export type CycleOption = S["CycleOption"];
export type Trainee = S["TraineeOut"];
export type TraineeMe = S["TraineeMe"];
export type Project = S["ProjectOut"];
export type ProjectStats = S["ProjectStats"];
export type Factor = S["FactorOut"];
export type Allocation = S["AllocationOut"];
export type Submission = S["SubmissionOut"];
export type Evaluation = S["EvaluationOut"];
export type ReportEvaluationSummary = S["ReportEvaluationSummary"];
export type Analysis = S["AnalysisOut"];
export type ProgressRow = S["ProgressRow"];
export type TrackingSummary = S["TrackingSummary"];
export type Invitation = S["InvitationRow"];
export type ImportResult = S["ImportResult"];
export type StaffImportResult = S["StaffImportResult"];
export type Overview = S["Overview"];
export type Automation = S["AutomationStats"];
export type ArchivePreview = S["ArchivePreview"];
export type NamedRef = S["NamedRef"];
export type PageMeta = S["PageMeta"];
export type ProjectPatch = S["ProjectPatch"];
export type TraineeAdminPatch = S["TraineeAdminPatch"];
export type EvaluationIn = S["EvaluationIn"];
export type Resume = S["ResumeOut"];
export type Onboarding = S["OnboardingOut"];
export type OnboardingData = S["OnboardingData"];
export type HistoryEntry = S["HistoryEntry"];
export type Rejection = S["RejectionOut"];
export type AppNotification = S["NotificationOut"];

export type UserRole = User["role"];
