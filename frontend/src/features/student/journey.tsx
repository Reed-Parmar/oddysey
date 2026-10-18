/**
 * The trainee's own path through the automated lifecycle (ADR-017). Pure: derived only from data the dashboard
 * already loads (TraineeMe, the active allocation, the latest submission). Presentation only.
 */
import { ClipboardText, FileMagnifyingGlass, FlagCheckered, IdentificationCard, UploadSimple, UserPlus } from "@phosphor-icons/react";

import type { Allocation, Submission, TraineeMe } from "@/api/types";
import type { PipelineStage, PipelineStatus } from "@/components/shared/Pipeline";
import { label } from "@/lib/statusLabels";

const ANALYSIS_RUNNING = new Set(["queued", "extracting", "analysing", "retrying"]);
const ANALYSIS_FAILED = new Set(["failed", "not_analyzable"]);

export function buildJourney(me: TraineeMe, allocation: Allocation | null, latest: Submission | undefined): PipelineStage[] {
  const a = allocation;
  const profileDone = me.skills.length > 0 && !!me.career_interest;
  const verified = me.assessment_status === "complete";
  const trades = (me.trades.length ? me.trades : [me.trade]).map((t) => t.name).join(", ");

  const evalStatus: PipelineStatus = !latest
    ? "idle"
    : latest.status === "evaluated"
      ? "done"
      : latest.status === "rework_requested"
        ? "attention"
        : ANALYSIS_FAILED.has(latest.analysis_status)
          ? "error"
          : ANALYSIS_RUNNING.has(latest.analysis_status)
            ? "active"
            : "waiting";

  return [
    {
      key: "onboarding",
      title: "Trainee Onboarding",
      icon: <UserPlus />,
      status: "done",
      statusLabel: "Enrolled",
      summary: "Your account is linked to your trainee record for this cycle.",
      details: [{ label: "Trade", value: trades }],
    },
    {
      key: "verification",
      title: "Profile Verification",
      icon: <IdentificationCard />,
      status: profileDone ? "done" : "attention",
      statusLabel: !profileDone ? "Add skills and interest" : verified ? "Verified marks" : "Profile-based",
      summary: !profileDone
        ? "Add your skills and a career interest on the Profile page (uploading your resume fills them in). Matching uses them."
        : verified
          ? "Your verified practical marks are on record, so you are matched using your full assessment."
          : "You are matched on your skills and career interest. When the programme team records your practical marks, matching also uses them.",
      details: [
        { label: "Skills", value: me.skills.length },
        { label: "Career interest", value: me.career_interest ? "Added" : "Missing" },
        { label: "Assessment", value: label("assessment", me.assessment_status)[0] },
      ],
      link: { to: "/student/profile", label: profileDone ? "Open profile" : "Complete profile" },
    },
    {
      key: "projects",
      title: "Project Analysis",
      icon: <FileMagnifyingGlass />,
      status: a ? "done" : "waiting",
      statusLabel: a ? "Project ready" : "Handled automatically",
      summary: "Projects are prepared from their documents by the programme's automation. You don't need to do anything here.",
      link: a ? { to: "/student/project", label: "Open My Project" } : undefined,
    },
    {
      key: "submission",
      title: "Student Submission",
      icon: <UploadSimple />,
      status: !a ? "idle" : !latest ? "attention" : latest.status === "rework_requested" ? "attention" : "done",
      statusLabel: !a ? "Not started" : !latest ? "Your turn: submit report" : latest.status === "rework_requested" ? "Rework requested" : `Version ${latest.version} submitted`,
      summary: "Submit a written report (a video alone is not enough). If rework is requested, you submit a new version.",
      link: a ? { to: "/student/submissions", label: latest ? "View submissions" : "Submit report" } : undefined,
    },
    {
      key: "evaluation",
      title: "Evaluation",
      icon: <ClipboardText />,
      status: evalStatus,
      statusLabel: !latest ? "Not started" : latest.status === "evaluated" ? "Evaluated" : latest.status === "rework_requested" ? "Rework requested" : evalStatus === "waiting" ? "Supervisor reviewing" : label("analysis", latest.analysis_status)[0],
      summary: "Your report gets an automated evaluation. Your supervisor reviews it before finalising.",
    },
    {
      key: "completion",
      title: "Completion",
      icon: <FlagCheckered />,
      status: latest?.status === "evaluated" ? "done" : "idle",
      statusLabel: latest?.status === "evaluated" ? "Completed" : "Not yet",
      summary: latest?.status === "evaluated" ? "Your project is complete. Your results stay available in My Project." : "Your project completes when your latest version is evaluated.",
    },
  ];
}
