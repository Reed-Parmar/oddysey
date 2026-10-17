import { Route } from "react-router-dom";

import {
  AdminOverview, CycleDetailPage, CyclesPage, ProjectDetailPage, ProjectNewPage, ProjectsPage, TraineeDetailPage,
  TraineesPage, UsersPage,
} from "./data";
import { AdminProgressPage, AdminSubmissionPage, AllocationsPage, RecommendationsPage } from "./engine";

/** Admin module routes (relative to /admin). */
export const adminRoutes = [
  <Route key="index" index element={<AdminOverview />} />,
  <Route key="trainees" path="trainees" element={<TraineesPage />} />,
  <Route key="trainee" path="trainees/:traineeId" element={<TraineeDetailPage />} />,
  <Route key="projects" path="projects" element={<ProjectsPage />} />,
  <Route key="project-new" path="projects/new" element={<ProjectNewPage />} />,
  <Route key="project" path="projects/:projectId" element={<ProjectDetailPage />} />,
  <Route key="recs" path="recommendations" element={<RecommendationsPage />} />,
  <Route key="allocs" path="allocations" element={<AllocationsPage />} />,
  <Route key="progress" path="progress" element={<AdminProgressPage />} />,
  <Route key="submission" path="submissions/:submissionId" element={<AdminSubmissionPage />} />,
  <Route key="cycles" path="cycles" element={<CyclesPage />} />,
  <Route key="cycle" path="cycles/:cycleId" element={<CycleDetailPage />} />,
  <Route key="users" path="users" element={<UsersPage />} />,
];
