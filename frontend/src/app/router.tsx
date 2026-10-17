import { BrowserRouter, Route, Routes } from "react-router-dom";

import { RequireAuth, RequireRole, RoleRedirect, StudentGate } from "@/auth/guards";
import { NotFound } from "@/components/shared";
import { adminRoutes } from "@/features/admin/routes";
import { Account, Landing, Login, Register } from "@/features/public/pages";
import { studentRoutes } from "@/features/student/routes";
import { supervisorRoutes } from "@/features/supervisor/routes";

import { AppShell } from "./AppShell";

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
            <Route element={<StudentGate />}>{studentRoutes}</Route>
          </Route>
          <Route path="/supervisor" element={<RequireRole role="supervisor" />}>{supervisorRoutes}</Route>
          <Route path="/admin" element={<RequireRole role="admin" />}>{adminRoutes}</Route>
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
