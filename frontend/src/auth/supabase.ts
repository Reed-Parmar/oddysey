import { createClient } from "@supabase/supabase-js";

/** Browser client: publishable key only, used for auth calls and nothing else (architecture.md §2). */
export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL ?? "http://localhost",
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "missing-key",
  { auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true } },
);

export const INVITE_KEY = "spa.invite";
