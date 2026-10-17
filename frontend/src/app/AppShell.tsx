import { List, SignOut, X } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";

import { api, call } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { useAuth } from "@/auth/AuthProvider";
import { Avatar } from "@/components/shared";
import { StatusBadge } from "@/components/shared/StatusBadge";

import { HOME, NAV, ROLE_LABEL } from "./nav";

/** The caller's default cycle (CYC-01): a student's own cycle; for staff the newest active one (a UI default). */
export function useCurrentCycle() {
  return useQuery({ queryKey: qk.cycles.current(), queryFn: () => call(api.GET("/api/v1/cycles/current")) });
}

/** Every active cycle, newest first (CYC-07, staff only; ADR-018: several may be active). */
export function useActiveCycles(enabled = true) {
  return useQuery({ queryKey: qk.cycles.active(), queryFn: () => call(api.GET("/api/v1/cycles/active")), enabled });
}

/** Three connected nodes: the automated pipeline as the brand. */
export function BrandMark({ className = "size-8" }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={className}>
      <rect width="32" height="32" rx="8" fill="var(--color-primary)" />
      <path d="M10 22 16 10l6 12" stroke="white" strokeOpacity="0.55" strokeWidth="2" fill="none" strokeLinejoin="round" />
      <circle cx="10" cy="22" r="3" fill="white" />
      <circle cx="16" cy="10" r="3" fill="white" />
      <circle cx="22" cy="22" r="3" fill="var(--color-accent-soft)" stroke="var(--color-accent)" strokeWidth="1.5" />
    </svg>
  );
}

export function AppShell() {
  const { user, signOut } = useAuth();
  const cycle = useCurrentCycle();
  const actives = useActiveCycles(!!user && user.role !== "student");
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);

  // Move focus to the page on navigation (screen readers announce the new page); close the drawer.
  useEffect(() => {
    setOpen(false);
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!user) return null;
  const items = NAV[user.role];
  const c = cycle.data?.data;
  // Staff: every active cycle (ADR-018). Students: their own cycle.
  const shown = user.role === "student" ? (c ? [c] : []) : (actives.data?.data ?? []);

  const nav = (
    <nav aria-label="Main" className="flex flex-col gap-0.5 px-3 py-4">
      {items.map((i) => (
        <Fragment key={i.to}>
          {i.section && (
            <p className="mt-5 mb-1.5 px-3 text-[0.7rem] font-semibold tracking-wider text-chrome-muted uppercase first:mt-0">{i.section}</p>
          )}
          <NavLink
            to={i.to}
            end={i.end}
            className={({ isActive }) =>
              `group relative flex min-h-10 items-center gap-3 rounded-lg px-3 text-sm transition-colors duration-150 ${
                isActive ? "bg-white/10 font-semibold text-white" : "font-medium text-chrome-text hover:bg-white/5 hover:text-white"
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span aria-hidden className="absolute top-2 bottom-2 left-0 w-[3px] rounded-r-full bg-chrome-accent" />}
                <i.icon aria-hidden size={20} weight={isActive ? "fill" : "regular"} className={isActive ? "text-white" : "text-chrome-muted group-hover:text-white"} />
                {i.label}
              </>
            )}
          </NavLink>
        </Fragment>
      ))}
    </nav>
  );

  const brand = (
    <Link to={HOME[user.role]} className="flex items-center gap-2.5 rounded-lg">
      <BrandMark />
      <span className="leading-tight">
        <span className="block font-heading text-[0.95rem] font-semibold text-white">Smart Allocation</span>
        <span className="block text-xs text-chrome-muted">Tata STRIVE · ITI projects</span>
      </span>
    </Link>
  );

  const cyclePill = shown.length > 0 && (
    <div className="rounded-lg border border-white/10 bg-chrome-2 px-3 py-2.5">
      <p className="text-[0.7rem] font-semibold tracking-wider text-chrome-muted uppercase">
        {user.role === "student" ? "Your cycle" : shown.length > 1 ? `Active cycles (${shown.length})` : "Active cycle"}
      </p>
      <ul className="mt-0.5 flex flex-col gap-0.5">
        {shown.slice(0, 4).map((x) => (
          <li key={x.id} className="truncate text-sm font-semibold text-white" title={x.name}>{x.name}</li>
        ))}
        {shown.length > 4 && <li className="text-xs text-chrome-muted">+{shown.length - 4} more</li>}
      </ul>
      {shown.length === 1 && (
        <div className="mt-1.5">
          <StatusBadge kind="cycle" value={shown[0].status} />
        </div>
      )}
    </div>
  );

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only z-50 rounded-lg bg-primary px-4 py-2 font-semibold text-white focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to main content
      </a>

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-chrome lg:flex">
        <div className="flex h-16 items-center border-b border-white/10 px-5">{brand}</div>
        <div className="flex-1 overflow-y-auto">{nav}</div>
        {cyclePill && <div className="border-t border-white/10 p-3">{cyclePill}</div>}
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 animate-fade-in bg-text/40" onClick={() => setOpen(false)} aria-hidden />
          <aside
            id="mobile-nav"
            className="absolute inset-y-0 left-0 flex w-[min(18rem,85vw)] animate-slide-in flex-col bg-chrome shadow-overlay"
            aria-label="Navigation"
          >
            <div className="flex h-16 items-center justify-between border-b border-white/10 px-4">
              {brand}
              <button
                type="button"
                aria-label="Close navigation"
                className="inline-flex size-10 items-center justify-center rounded-lg text-chrome-text hover:bg-white/10 hover:text-white"
                onClick={() => setOpen(false)}
              >
                <X aria-hidden size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">{nav}</div>
            {cyclePill && <div className="border-t border-white/10 p-3">{cyclePill}</div>}
          </aside>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border bg-surface/90 px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            className="-ml-2 inline-flex size-10 items-center justify-center rounded-lg text-neutral hover:bg-neutral-bg lg:hidden"
            aria-label="Open navigation"
            aria-expanded={open}
            aria-controls="mobile-nav"
            onClick={() => setOpen(true)}
          >
            <List aria-hidden size={22} />
          </button>
          <div className="lg:hidden">
            <Link to={HOME[user.role]} aria-label="Smart Project Allocation home" className="flex items-center rounded-lg">
              <BrandMark className="size-7" />
            </Link>
          </div>
          {shown.length > 0 && (
            <span className="hidden min-w-0 items-center gap-2 text-sm text-muted md:flex lg:hidden">
              {shown.length > 1 ? <span className="truncate">{shown.length} active cycles</span> : <>
                <span className="truncate">{shown[0].name}</span> <StatusBadge kind="cycle" value={shown[0].status} />
              </>}
            </span>
          )}
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <Link
              to="/account"
              className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 transition-colors hover:bg-neutral-bg sm:px-2"
              aria-label={`Account: ${user.full_name}, ${ROLE_LABEL[user.role]}`}
            >
              <Avatar name={user.full_name} size="sm" />
              <span className="hidden text-left leading-tight sm:block">
                <span className="block max-w-[14rem] truncate text-sm font-semibold text-text">{user.full_name}</span>
                <span className="block text-xs text-muted">{ROLE_LABEL[user.role]}</span>
              </span>
            </Link>
            <span aria-hidden className="hidden h-6 w-px bg-border sm:block" />
            <button
              type="button"
              className="inline-flex min-h-10 items-center gap-2 rounded-lg px-3 text-sm font-semibold text-neutral transition-colors hover:bg-danger-bg hover:text-danger"
              onClick={() => void signOut()}
            >
              <SignOut aria-hidden size={18} />
              <span>Log out</span>
            </button>
          </div>
        </header>
        <main id="main" ref={mainRef} tabIndex={-1} className="mx-auto w-full max-w-7xl min-w-0 px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
