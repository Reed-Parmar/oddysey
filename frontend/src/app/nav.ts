import { ChartBar, ClipboardText, FolderSimple, House, type Icon, SquaresFour, TrendUp, UserPlus } from "@phosphor-icons/react";

import type { UserRole } from "@/api/types";

export type NavItem = { label: string; to: string; end?: boolean; icon: Icon; section?: string };

/** Role navigation, declared only here (frontend.md §2). `section` starts a labelled group. */
export const NAV: Record<UserRole, NavItem[]> = {
  // ADR-017: exactly two items for trainees; profile/resume live on the Dashboard, work in My Project.
  student: [
    { label: "Dashboard", to: "/student", end: true, icon: House },
    { label: "My Project", to: "/student/project", icon: ClipboardText },
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
    { label: "Staff & Invitations", to: "/admin/staff", icon: UserPlus },
  ],
};

export const HOME: Record<UserRole, string> = { student: "/student", supervisor: "/supervisor", admin: "/admin" };

export const ROLE_LABEL: Record<UserRole, string> = { student: "Trainee", supervisor: "Supervisor", admin: "Programme team" };
