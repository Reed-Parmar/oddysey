/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_PUBLISHABLE_KEY: string;
  /** ADR-031: domain of phone-derived trainee login emails (default trainee.spa.local). */
  readonly VITE_TRAINEE_LOGIN_DOMAIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
