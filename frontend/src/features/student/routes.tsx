import { Navigate, Route } from "react-router-dom";

import { NotFound } from "@/components/shared";

import { DashboardPage } from "./DashboardPage";
import { MyProjectPage } from "./MyProjectPage";
import { SubmissionDetailPage } from "./SubmissionPage";

/** Student module routes (relative to /student; mounted inside RequireRole + StudentGate). Owned by the Student module.
 * `/student/onboarding` is mounted by the app router outside the gate. Old links redirect (ADR-017 removed the catalogue). */
export const studentRoutes = [
  <Route key="index" index element={<DashboardPage />} />,
  <Route key="project" path="project" element={<MyProjectPage />} />,
  <Route key="submission-detail" path="submissions/:submissionId" element={<SubmissionDetailPage />} />,
  <Route key="profile" path="profile" element={<Navigate to="/student" replace />} />,
  <Route key="recommendations" path="recommendations" element={<Navigate to="/student/project" replace />} />,
  <Route key="projects" path="projects" element={<Navigate to="/student/project" replace />} />,
  <Route key="projects-detail" path="projects/:projectId" element={<Navigate to="/student/project" replace />} />,
  <Route key="submission" path="submission" element={<Navigate to="/student/project" replace />} />,
  <Route key="not-found" path="*" element={<NotFound />} />,
];
