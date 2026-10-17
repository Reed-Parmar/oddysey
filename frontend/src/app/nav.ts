import {
  ChartBar,
  ClipboardText,
  FolderSimple,
  GraduationCap,
  House,
  type Icon,
  ListMagnifyingGlass,
  Sparkle,
  SquaresFour,
  Strategy,
  TrendUp,
  UserCircle,
  CalendarBlank,
  UserPlus,
} from "@phosphor-icons/react";

import type { UserRole } from "@/api/types";

export type NavItem = { label: string; to: string; end?: boolean; icon: Icon; section?: string };

/** Role navigation, declared only here (frontend.md §2). `section` starts a labelled group. */
export const NAV: Record<UserRole, NavItem[]> = {
  student: [
    { label: "Dashboard", to: "/student", end: true, icon: House },
    { label: "My profile", to: "/student/profile", icon: UserCircle },
    { label: "Suggested projects", to: "/student/recommendations", icon: Sparkle, section: "Projects" },
    { label: "Project catalogue", to: "/student/projects", icon: ListMagnifyingGlass },
    { label: "My project & submission", to: "/student/submission", icon: ClipboardText },
  ],
  supervisor: [
    { label: "Dashboard", to: "/supervisor", end: true, icon: House },
    { label: "My projects", to: "/supervisor/projects", icon: FolderSimple },
    { label: "Evaluations", to: "/supervisor/submissions", icon: ClipboardText },
    { label: "Progress", to: "/supervisor/progress", icon: TrendUp },
  ],
  admin: [
    { label: "Overview", to: "/admin", end: true, icon: SquaresFour },
    { label: "Trainees", to: "/admin/trainees", icon: GraduationCap, section: "Data" },
    { label: "Projects", to: "/admin/projects", icon: FolderSimple },
    { label: "Recommendations", to: "/admin/recommendations", icon: Sparkle, section: "Allocation" },
    { label: "Allocations", to: "/admin/allocations", icon: Strategy },
    { label: "Progress", to: "/admin/progress", icon: ChartBar },
    { label: "Cycles", to: "/admin/cycles", icon: CalendarBlank, section: "Setup" },
    { label: "Users & invites", to: "/admin/users", icon: UserPlus },
  ],
};

export const HOME: Record<UserRole, string> = { student: "/student", supervisor: "/supervisor", admin: "/admin" };

export const ROLE_LABEL: Record<UserRole, string> = { student: "Trainee", supervisor: "Supervisor", admin: "Programme team" };
