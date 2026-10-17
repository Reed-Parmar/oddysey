import createClient, { type Middleware } from "openapi-fetch";

import { supabase } from "@/auth/supabase";

import { ApiError, toApiError } from "./errors";
import type { paths } from "./schema.gen";

export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000/api/v1").replace(/\/$/, "");
// openapi paths already include /api/v1
const ORIGIN = API_BASE.replace(/\/api\/v1$/, "");

let onSessionEnd: ((reason: "expired" | "disabled") => void) | null = null;
export function setSessionEndHandler(fn: (reason: "expired" | "disabled") => void) {
  onSessionEnd = fn;
}

export async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const h: Record<string, string> = { "X-Request-ID": crypto.randomUUID() };
  if (data.session) h.Authorization = `Bearer ${data.session.access_token}`;
  return h;
}

/** Shared response policy: one refresh-and-retry on 401; ACCOUNT_DISABLED signs out. */
export async function handleAuthFailure(res: Response, retry: () => Promise<Response>): Promise<Response> {
  if (res.status === 401) {
    const { data } = await supabase.auth.refreshSession();
    if (data.session) {
      const again = await retry();
      if (again.status !== 401) return again;
    }
    onSessionEnd?.("expired");
    return res;
  }
  if (res.status === 403) {
    const peek = await res.clone().json().catch(() => null);
    if (peek?.error?.code === "ACCOUNT_DISABLED") onSessionEnd?.("disabled");
  }
  return res;
}

const middleware: Middleware = {
  async onRequest({ request }) {
    for (const [k, v] of Object.entries(await authHeaders())) request.headers.set(k, v);
    return request;
  },
  async onResponse({ request, response }) {
    return handleAuthFailure(response, async () => {
      const req = request.clone();
      req.headers.set("Authorization", (await authHeaders()).Authorization ?? "");
      return fetch(req);
    });
  },
};

export const api = createClient<paths>({ baseUrl: ORIGIN });
api.use(middleware);

/** Unwraps openapi-fetch results: returns `data` or throws ApiError. */
export async function call<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  let result: { data?: T; error?: unknown; response: Response };
  try {
    result = await p;
  } catch {
    throw new ApiError(0, "NETWORK_ERROR", "Cannot reach the server. Check your connection and try again.");
  }
  if (!result.response.ok) throw await toApiError(result.response, result.error);
  return result.data as T;
}
