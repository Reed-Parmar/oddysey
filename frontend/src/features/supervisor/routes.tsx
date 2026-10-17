import { Route } from "react-router-dom";

import { NotFound } from "@/components/shared";

import { DashboardPage } from "./pages/Dashboard";
import { ProgressPage } from "./pages/Progress";
import { ProjectDetailPage } from "./pages/ProjectDetail";
import { ProjectsPage } from "./pages/Projects";
import { SubmissionDetailPage } from "./pages/SubmissionDetail";
import { SubmissionsPage } from "./pages/Submissions";
import { TraineeProfilePage } from "./pages/TraineeProfile";

/** Supervisor module routes (relative to /supervisor). Owned by the Supervisor module. */
export const supervisorRoutes = [
  <Route key="index" index element={<DashboardPage />} />,
  <Route key="projects" path="projects" element={<ProjectsPage />} />,
  <Route key="project" path="projects/:projectId" element={<ProjectDetailPage />} />,
  <Route key="submissions" path="submissions" element={<SubmissionsPage />} />,
  <Route key="submission" path="submissions/:submissionId" element={<SubmissionDetailPage />} />,
  <Route key="progress" path="progress" element={<ProgressPage />} />,
  <Route key="trainee" path="trainees/:traineeId" element={<TraineeProfilePage />} />,
  <Route key="notfound" path="*" element={<NotFound />} />,
];
