/**
 * ADR-031: trainees created by the programme team log in with their phone number. Supabase has no SMS provider here,
 * so the account's login email is derived from the phone, exactly as the API does (IMP-04):
 * `91XXXXXXXXXX@<VITE_TRAINEE_LOGIN_DOMAIN>` (default `trainee.spa.local`, must equal TRAINEE_LOGIN_EMAIL_DOMAIN).
 */
export const TRAINEE_LOGIN_DOMAIN = (import.meta.env.VITE_TRAINEE_LOGIN_DOMAIN || "trainee.spa.local").toLowerCase();

/** A 10-digit Indian mobile (spaces, dashes, brackets, a +91 / 91 / 0 prefix allowed) → `+91XXXXXXXXXX`, else null. */
export function normalisePhone(raw: string): string | null {
  let d = raw.trim().replace(/[\s\-().]/g, "");
  if (d.startsWith("+")) {
    if (!d.startsWith("+91")) return null;
    d = d.slice(3);
  } else if (d.length === 12 && d.startsWith("91")) {
    d = d.slice(2);
  } else if (d.length === 11 && d.startsWith("0")) {
    d = d.slice(1);
  }
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
}

/** The email to pass to `signInWithPassword`: an email as typed (trimmed), or the derived email for a phone number. */
export function loginEmail(input: string): string | null {
  const v = input.trim();
  if (v.includes("@")) return v;
  const phone = normalisePhone(v);
  return phone ? `${phone.slice(1)}@${TRAINEE_LOGIN_DOMAIN}` : null;
}
