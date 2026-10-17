import { Route } from "react-router-dom";

import { NotFound } from "@/components/shared";

import { DashboardPage } from "./DashboardPage";
import { ProfilePage } from "./ProfilePage";
import { ProjectDetailPage, ProjectsPage } from "./ProjectsPage";
import { RecommendationsPage } from "./RecommendationsPage";
import { SubmissionDetailPage, SubmissionPage } from "./SubmissionPage";

/** Student module routes (relative to /student; mounted inside RequireRole + StudentGate). Owned by the Student module. */
export const studentRoutes = [
  <Route key="index" index element={<DashboardPage />} />,
  <Route key="profile" path="profile" element={<ProfilePage />} />,
  <Route key="recommendations" path="recommendations" element={<RecommendationsPage />} />,
  <Route key="projects" path="projects" element={<ProjectsPage />} />,
  <Route key="project" path="projects/:projectId" element={<ProjectDetailPage />} />,
  <Route key="submission" path="submission" element={<SubmissionPage />} />,
  <Route key="submission-detail" path="submissions/:submissionId" element={<SubmissionDetailPage />} />,
  <Route key="not-found" path="*" element={<NotFound />} />,
];
