import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { useAuth } from "@/auth/AuthProvider";
import { StatusBadge } from "@/components/shared/StatusBadge";

import { HOME, NAV } from "./nav";

export function useCurrentCycle() {
  return useQuery({ queryKey: qk.cycles.current(), queryFn: () => call(api.GET("/api/v1/cycles/current")) });
}

export function AppShell() {
  const { user, signOut } = useAuth();
  const cycle = useCurrentCycle();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  const items = NAV[user.role];
  const c = cycle.data?.data;

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-1 p-3">
      {items.map((i) => (
        <NavLink
          key={i.to}
          to={i.to}
          end={i.end}
          onClick={() => setOpen(false)}
          className={({ isActive }) =>
            `rounded-md px-3 py-2 text-sm ${isActive ? "bg-primary/10 font-medium text-primary" : "text-neutral hover:bg-neutral-bg"}`
          }
        >
          {i.label}
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface px-4">
        <button
          type="button"
          className="rounded-md p-2 md:hidden"
          aria-label="Open navigation"
          onClick={() => setOpen((o) => !o)}
        >
          ☰
        </button>
        <Link to={HOME[user.role]} className="font-semibold">
          Smart Project Allocation
        </Link>
        {c && (
          <span className="hidden items-center gap-2 text-sm text-muted sm:flex">
            {c.name} <StatusBadge kind="cycle" value={c.status} />
          </span>
        )}
        <div className="ml-auto flex items-center gap-3 text-sm">
          <Link to="/account" className="hidden sm:inline">
            {user.full_name} <span className="text-muted">· {user.role}</span>
          </Link>
          <button type="button" className="rounded-md border border-border px-3 py-1.5" onClick={() => void signOut()}>
            Log out
          </button>
        </div>
      </header>
      <div className="flex">
        <aside className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-60 shrink-0 border-r border-border bg-surface md:block">
          {nav}
        </aside>
        {open && (
          <div className="fixed inset-0 top-14 z-10 bg-black/30 md:hidden" onClick={() => setOpen(false)}>
            <aside className="h-full w-64 bg-surface" onClick={(e) => e.stopPropagation()}>
              {nav}
            </aside>
          </div>
        )}
        <main className="mx-auto w-full max-w-[1200px] min-w-0 p-4 md:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
