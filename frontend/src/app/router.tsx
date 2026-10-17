import { lazy, Suspense, type ReactElement } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";

import { RequireAuth, RequireRole, RoleRedirect, StudentGate } from "@/auth/guards";
import { LoadingState, NotFound } from "@/components/shared";
import { Account, Landing, Login, Register } from "@/features/public/pages";

import { AppShell } from "./AppShell";
import { AreaBoundary } from "./AreaBoundary";

/** Each role area is its own chunk, loaded on first visit (route-level code splitting). */
const area = (load: () => Promise<ReactElement[]>) =>
  lazy(async () => {
    const routes = await load();
    return { default: () => <Routes>{routes}</Routes> };
  });

const StudentArea = area(() => import("@/features/student/routes").then((m) => m.studentRoutes));
const SupervisorArea = area(() => import("@/features/supervisor/routes").then((m) => m.supervisorRoutes));
const AdminArea = area(() => import("@/features/admin/routes").then((m) => m.adminRoutes));
const StudentOnboarding = lazy(() => import("@/features/student/OnboardingPage").then((m) => ({ default: m.OnboardingPage })));

const load = (el: ReactElement) => (
  <AreaBoundary>
    <Suspense fallback={<LoadingState />}>{el}</Suspense>
  </AreaBoundary>
);

export function AppRouter() {
  return (
    <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route element={<RequireAuth><AppShell /></RequireAuth>}>
          <Route path="/app" element={<RoleRedirect />} />
          <Route path="/account" element={<Account />} />
          <Route path="/student" element={<RequireRole role="student" />}>
            <Route path="onboarding" element={load(<StudentOnboarding />)} />
            <Route element={<StudentGate />}>
              <Route path="*" element={load(<StudentArea />)} />
            </Route>
          </Route>
          <Route path="/supervisor" element={<RequireRole role="supervisor" />}>
            <Route path="*" element={load(<SupervisorArea />)} />
          </Route>
          <Route path="/admin" element={<RequireRole role="admin" />}>
            <Route path="*" element={load(<AdminArea />)} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
