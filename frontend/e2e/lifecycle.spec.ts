import { expect, test, type Page } from "@playwright/test";

const PASSWORD = process.env.E2E_PASSWORD ?? "";

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Log in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

async function logout(page: Page) {
  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("link", { name: "Log in" }).first()).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("full lifecycle: recommend → allocate → override → publish → submit → rework → evaluate", async ({ page }) => {
  test.skip(!PASSWORD, "set E2E_PASSWORD");

  // ---------------- admin: recommendations
  await login(page, "admin@spa-demo.org");
  await expect(page).toHaveURL(/\/admin$/);
  await page.getByRole("link", { name: "Recommendations" }).first().click();
  await page.getByRole("button", { name: /Generate recommendations|Run recommendations/ }).click();
  await expect(page.getByText("Completed").first()).toBeVisible({ timeout: 120_000 });

  // ---------------- admin: auto-allocate, override, publish
  await page.getByRole("link", { name: "Allocations" }).first().click();
  await page.getByRole("button", { name: "Auto-allocate" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Auto-allocate" }).click();
  await expect(page.getByText("TRN-CP-008").first()).toBeVisible();

  await page.getByRole("button", { name: "Allocate manually" }).first().click();
  const dialog = page.getByRole("dialog");
  const vikas = dialog.getByLabel("Trainee").locator("option", { hasText: "TRN-CP-008" });
  await expect(vikas).toHaveCount(1);
  await dialog.getByLabel("Trainee").selectOption((await vikas.getAttribute("value")) ?? "");
  const portal = dialog.getByLabel("Project").locator("option", { hasText: "PRJ-CP-401" });
  await dialog.getByLabel("Project").selectOption(await portal.getAttribute("value") ?? "");
  await dialog.getByRole("button", { name: /^Allocate/ }).click();
  await expect(dialog.getByText("This pair is ineligible")).toBeVisible();
  await dialog.getByLabel("Override reason").fill("Strong database skills; 2 points below the minimum.");
  await dialog.getByRole("button", { name: "Allocate with override" }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByRole("button", { name: "Publish allocations" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Allocations are published").first()).toBeVisible();
  await logout(page);

  // ---------------- student: sees allocation, submits v1
  await login(page, "priya@spa-demo.org");
  await page.getByRole("link", { name: "My project & submission" }).first().click();
  await expect(page.getByText("PRJ-EL-101").first()).toBeVisible();
  await page.getByLabel("Video link").fill("https://youtu.be/solar-tracker-demo");
  await page.getByLabel("Logbook hours").fill("36");
  await page.getByRole("button", { name: "Submit version 1" }).click();
  await expect(page.getByText("Awaiting evaluation").first()).toBeVisible();
  await logout(page);

  // ---------------- supervisor: request rework
  await login(page, "mehta@spa-demo.org");
  await page.getByRole("link", { name: "Evaluations" }).first().click();
  await page.getByRole("link", { name: /Priya Sharma/ }).first().click();
  await page.getByLabel("Request rework").check();
  await page.getByLabel("Feedback").fill("Please add the tracking-accuracy test log to your report.");
  await page.getByRole("button", { name: "Request rework" }).click();
  await expect(page.getByText("Rework requested").first()).toBeVisible();
  await logout(page);

  // ---------------- student: resubmits v2
  await login(page, "priya@spa-demo.org");
  await page.getByRole("link", { name: "My project & submission" }).first().click();
  await expect(page.getByText("tracking-accuracy test log").first()).toBeVisible();
  await page.getByLabel("Report link").fill("https://drive.google.com/report-v2");
  await page.getByRole("button", { name: "Submit version 2" }).click();
  await expect(page.getByText("Awaiting evaluation").first()).toBeVisible();
  await logout(page);

  // ---------------- supervisor: final rubric evaluation
  await login(page, "mehta@spa-demo.org");
  await page.getByRole("link", { name: "Evaluations" }).first().click();
  await page.getByRole("link", { name: /Priya Sharma/ }).first().click();
  await page.getByLabel("Evaluated (final)").check();
  await page.getByLabel(/Workmanship/).fill("24");
  await page.getByLabel(/Functional working demo/).fill("25");
  await page.getByLabel(/Safety & SOP/).fill("15");
  await page.getByLabel(/Logbook & documentation/).fill("14");
  await page.getByLabel(/Viva voce/).fill("18");
  await expect(page.getByText("Total 96 / 100").first()).toBeVisible();
  await page.getByRole("button", { name: "Submit final evaluation" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Submit evaluation" }).click();
  await expect(page.getByText("A1 (Exemplary)").first()).toBeVisible();
  await logout(page);

  // ---------------- admin: progress shows the graded trainee
  await login(page, "admin@spa-demo.org");
  await page.getByRole("link", { name: "Progress" }).first().click();
  await expect(page.getByText("A1 (Exemplary)").first()).toBeVisible();

  // ---------------- cross-role: a student cannot open admin pages
  await logout(page);
  await login(page, "priya@spa-demo.org");
  await page.goto("/admin/allocations");
  await expect(page.getByText("You don't have access to this page")).toBeVisible();
});
