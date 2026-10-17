import { expect, test, type Page } from "@playwright/test";

/**
 * ADR-017 demo path against the real stack (seeded with `uv run python -m scripts.seed --reset` and a running
 * worker or RUN_WORKER_IN_API=true). Only run against a disposable demo project: it rejects an allocation and
 * submits a report link.
 */
const PASSWORD = process.env.E2E_PASSWORD ?? "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

async function logout(page: Page) {
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("button", { name: "Log in" })).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("automated allocation → student sees only own project → rejection → report → analysis review", async ({ page }) => {
  test.skip(!PASSWORD, "set E2E_PASSWORD");

  // ---------------- admin: overview + tracking (no recommendation or publish step exists)
  await login(page, "admin@spa-demo.org");
  await page.goto("/admin");
  await expect(page.getByText(/Run allocation now/)).toBeVisible();
  await page.goto("/admin/tracking");
  await expect(page.getByRole("heading", { name: "Allocation & Progress" })).toBeVisible();
  await page.goto("/admin/recommendations");
  await expect(page).toHaveURL(/\/admin\/tracking$/);
  await logout(page);

  // ---------------- student: two nav items, own project, rejection
  await login(page, "priya@spa-demo.org");
  const nav = page.getByRole("navigation").first();
  await expect(nav.getByRole("link", { name: "Dashboard" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "My Project" })).toBeVisible();
  await page.goto("/student/projects");
  await expect(page).toHaveURL(/\/student\/project$/);
  await expect(page.getByText(/Why this project was allocated to me/)).toBeVisible();
  await page.getByRole("button", { name: "Reject this project" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("I would like to work in a different area of my trade.");
  await dialog.getByRole("button", { name: /Reject/ }).click();
  await expect(page.getByText(/Finding a different eligible project|different eligible project/).first()).toBeVisible();

  // after the next automatic run the student has a different project; submit a report link (video alone is refused)
  await expect(async () => {
    await page.reload();
    await expect(page.getByText(/Why this project was allocated to me/)).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 120_000 });
  await page.getByLabel("Report link").fill("https://example.org/priya-report.pdf");
  await page.getByRole("button", { name: /Submit version 1/ }).click();
  await expect(page.getByText(/Version 1/).first()).toBeVisible();
  await logout(page);
});
