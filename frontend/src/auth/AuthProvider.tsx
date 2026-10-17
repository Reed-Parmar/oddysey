import type { Session } from "@supabase/supabase-js";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { api, call, setSessionEndHandler } from "@/api/client";
import { ApiError } from "@/api/errors";
import type { User } from "@/api/types";

import { INVITE_KEY, supabase } from "./supabase";

type AuthState =
  | { status: "loading" }
  | { status: "signedOut"; notice?: string }
  | { status: "provisioning" }
  | { status: "ready"; user: User; session: Session }
  | { status: "error"; message: string };

type AuthContextValue = {
  state: AuthState;
  user: User | null;
  signOut: (notice?: string) => Promise<void>;
  refreshUser: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function readInvite(): string | null {
  try {
    return sessionStorage.getItem(INVITE_KEY);
  } catch {
    return null;
  }
}

function clearInvite() {
  try {
    sessionStorage.removeItem(INVITE_KEY);
  } catch {
    /* storage unavailable */
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });
  const queryClient = useQueryClient();

  const signOut = useCallback(
    async (notice?: string) => {
      await supabase.auth.signOut();
      queryClient.clear();
      setState({ status: "signedOut", notice });
    },
    [queryClient],
  );

  const resolveUser = useCallback(
    async (session: Session | null) => {
      if (!session) {
        setState((s) => (s.status === "signedOut" ? s : { status: "signedOut" }));
        return;
      }
      try {
        const me = await call(api.GET("/api/v1/me"));
        setState({ status: "ready", user: me.data, session });
      } catch (e) {
        if (e instanceof ApiError && e.code === "NOT_PROVISIONED") {
          setState({ status: "provisioning" });
          const token = readInvite();
          try {
            const res = await call(
              api.POST("/api/v1/auth/provision", { body: token ? { invitation_token: token } : {} }),
            );
            clearInvite();
            setState({ status: "ready", user: res.data, session });
          } catch (pe) {
            clearInvite();
            if (pe instanceof ApiError && pe.code === "INVITATION_INVALID") {
              await signOut("This invitation link is invalid or has expired. Ask your coordinator for a new one.");
            } else {
              setState({ status: "error", message: pe instanceof Error ? pe.message : "Could not set up your account" });
            }
          }
        } else if (e instanceof ApiError && e.code === "ACCOUNT_DISABLED") {
          await signOut("Your account has been disabled. Contact your coordinator.");
        } else {
          setState({ status: "error", message: e instanceof Error ? e.message : "Could not load your account" });
        }
      }
    },
    [signOut],
  );

  useEffect(() => {
    setSessionEndHandler((reason) =>
      void signOut(
        reason === "disabled"
          ? "Your account has been disabled. Contact your coordinator."
          : "Your session expired. Please log in again.",
      ),
    );
    supabase.auth.getSession().then(({ data }) => resolveUser(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT") void resolveUser(session);
      if (event === "TOKEN_REFRESHED" && session)
        setState((s) => (s.status === "ready" ? { ...s, session } : s));
    });
    return () => sub.subscription.unsubscribe();
  }, [resolveUser, signOut]);

  const refreshUser = useCallback(async () => {
    const { data } = await supabase.auth.getSession();
    await resolveUser(data.session);
  }, [resolveUser]);

  const value = useMemo<AuthContextValue>(
    () => ({ state, user: state.status === "ready" ? state.user : null, signOut, refreshUser }),
    [state, signOut, refreshUser],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
