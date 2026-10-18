import { Navigate, Route } from "react-router-dom";

import { NotFound } from "@/components/shared";

import { AdminOverview, ProjectDetailPage, ProjectNewPage, ProjectsPage, StaffPage, TraineesPage } from "./data";
import { AdminSubmissionPage, TrackingPage } from "./engine";

/** Admin module routes (relative to /admin). Old screens redirect to their ADR-017 replacements. */
export const adminRoutes = [
  <Route key="index" index element={<AdminOverview />} />,
  <Route key="projects" path="projects" element={<ProjectsPage />} />,
  <Route key="project-new" path="projects/new" element={<ProjectNewPage />} />,
  <Route key="project" path="projects/:projectId" element={<ProjectDetailPage />} />,
  <Route key="tracking" path="tracking" element={<TrackingPage />} />,
  <Route key="staff" path="staff" element={<StaffPage />} />,
  <Route key="submission" path="submissions/:submissionId" element={<AdminSubmissionPage />} />,
  <Route key="cycles" path="cycles" element={<Navigate replace to="/admin" />} />,
  <Route key="cycle" path="cycles/:cycleId" element={<Navigate replace to="/admin" />} />,
  <Route key="recs" path="recommendations" element={<Navigate replace to="/admin/tracking" />} />,
  <Route key="allocs" path="allocations" element={<Navigate replace to="/admin/tracking" />} />,
  <Route key="progress" path="progress" element={<Navigate replace to="/admin/tracking" />} />,
  <Route key="trainees" path="trainees" element={<TraineesPage />} />, // ADR-031
  <Route key="trainee" path="trainees/:traineeId" element={<Navigate replace to="/admin/tracking" />} />,
  <Route key="users" path="users" element={<Navigate replace to="/admin/staff" />} />,
  <Route key="not-found" path="*" element={<NotFound />} />,
];
