import { defineConfig } from "@playwright/test";

/**
 * Full-stack E2E against real services: the local API (port 8000), Supabase Auth, and the Vite dev server.
 * Prerequisite: `cd backend && uv run python -m scripts.seed --reset --scenario imported`, then start the API.
 * Credentials come from E2E_PASSWORD (the seed's SEED_DEMO_PASSWORD).
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: { baseURL: "http://localhost:5173", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "pnpm dev", url: "http://localhost:5173", reuseExistingServer: true, timeout: 60_000 },
});
