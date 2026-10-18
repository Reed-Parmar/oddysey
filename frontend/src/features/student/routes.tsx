import { Navigate, Route } from "react-router-dom";

import { NotFound } from "@/components/shared";
import { StudentAssistant } from "@/features/shared/Autopilot";

import { DashboardPage } from "./DashboardPage";
import { MyProjectPage } from "./MyProjectPage";
import { SubmissionDetailPage } from "./SubmissionPage";
import { ProfilePage } from "./ProfilePage";
import { SubmissionsPage } from "./SubmissionsPage";
import { useStudentContext } from "./hooks";

/** ADR-030: every student page gets the floating Project Assistant once the trainee has an active allocation. */
function StudentLayout() {
  const { me } = useStudentContext();
  return <StudentAssistant hasProject={me?.allocation?.status === "active"} />;
}

/** Student module routes (relative to /student; mounted inside RequireRole + StudentGate). Owned by the Student module.
 * `/student/onboarding` is mounted by the app router outside the gate. Old links redirect (ADR-017 removed the catalogue).
 * All pages sit under one layout route that adds the Project Assistant (ADR-030). */
const pages = [
  <Route key="index" index element={<DashboardPage />} />,
  <Route key="project" path="project" element={<MyProjectPage />} />,
  <Route key="submissions" path="submissions" element={<SubmissionsPage />} />,
  <Route key="submission-detail" path="submissions/:submissionId" element={<SubmissionDetailPage />} />,
  <Route key="profile" path="profile" element={<ProfilePage />} />,
  <Route key="recommendations" path="recommendations" element={<Navigate to="/student/project" replace />} />,
  <Route key="projects" path="projects" element={<Navigate to="/student/project" replace />} />,
  <Route key="projects-detail" path="projects/:projectId" element={<Navigate to="/student/project" replace />} />,
  <Route key="submission" path="submission" element={<Navigate to="/student/submissions" replace />} />,
  <Route key="not-found" path="*" element={<NotFound />} />,
];

export const studentRoutes = [
  <Route key="layout" element={<StudentLayout />}>
    {pages}
  </Route>,
];
