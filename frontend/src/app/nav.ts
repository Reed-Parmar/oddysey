import type { UserRole } from "@/api/types";

export type NavItem = { label: string; to: string; end?: boolean };

/** Role navigation, declared only here (frontend.md §2). */
export const NAV: Record<UserRole, NavItem[]> = {
  student: [
    { label: "Dashboard", to: "/student", end: true },
    { label: "My profile", to: "/student/profile" },
    { label: "Suggested projects", to: "/student/recommendations" },
    { label: "Project catalogue", to: "/student/projects" },
    { label: "My project & submission", to: "/student/submission" },
  ],
  supervisor: [
    { label: "Dashboard", to: "/supervisor", end: true },
    { label: "My projects", to: "/supervisor/projects" },
    { label: "Evaluations", to: "/supervisor/submissions" },
    { label: "Progress", to: "/supervisor/progress" },
  ],
  admin: [
    { label: "Overview", to: "/admin", end: true },
    { label: "Trainees", to: "/admin/trainees" },
    { label: "Projects", to: "/admin/projects" },
    { label: "Recommendations", to: "/admin/recommendations" },
    { label: "Allocations", to: "/admin/allocations" },
    { label: "Progress", to: "/admin/progress" },
    { label: "Cycles", to: "/admin/cycles" },
    { label: "Users & invites", to: "/admin/users" },
  ],
};

export const HOME: Record<UserRole, string> = { student: "/student", supervisor: "/supervisor", admin: "/admin" };
