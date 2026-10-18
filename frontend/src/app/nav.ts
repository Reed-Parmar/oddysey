import { ChartBar, ClipboardText, FolderSimple, House, type Icon, SquaresFour, TrendUp, UploadSimple, UserCircle, UserPlus, UsersThree } from "@phosphor-icons/react";

import type { UserRole } from "@/api/types";

export type NavItem = { label: string; to: string; end?: boolean; icon: Icon; section?: string };

/** Role navigation, declared only here (frontend.md §2). `section` starts a labelled group. */
export const NAV: Record<UserRole, NavItem[]> = {
  // ADR-022/024 (amend ADR-017): the project in My Project, reports in Submissions, resume and profile in Profile.
  student: [
    { label: "Dashboard", to: "/student", end: true, icon: House },
    { label: "My Project", to: "/student/project", icon: ClipboardText },
    { label: "Submissions", to: "/student/submissions", icon: UploadSimple },
    { label: "Profile", to: "/student/profile", icon: UserCircle },
  ],
  supervisor: [
    { label: "Dashboard", to: "/supervisor", end: true, icon: House },
    { label: "My projects", to: "/supervisor/projects", icon: FolderSimple },
    { label: "Evaluations", to: "/supervisor/submissions", icon: ClipboardText },
    { label: "Progress", to: "/supervisor/progress", icon: TrendUp },
  ],
  admin: [
    { label: "Overview", to: "/admin", end: true, icon: SquaresFour },
    { label: "Projects", to: "/admin/projects", icon: FolderSimple },
    { label: "Allocation & Progress", to: "/admin/tracking", icon: ChartBar },
    { label: "Trainees", to: "/admin/trainees", icon: UsersThree }, // ADR-031
    { label: "Staff & Invitations", to: "/admin/staff", icon: UserPlus },
  ],
};

export const HOME: Record<UserRole, string> = { student: "/student", supervisor: "/supervisor", admin: "/admin" };

export const ROLE_LABEL: Record<UserRole, string> = { student: "Trainee", supervisor: "Supervisor", admin: "Programme team" };
