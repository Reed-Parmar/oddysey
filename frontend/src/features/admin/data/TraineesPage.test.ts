import { describe, expect, it } from "vitest";

import type { Trainee } from "@/api/types";

import { TRAINEE_TEMPLATE_CSV, loginStatus } from "./TraineesPage";

describe("admin Trainees page (ADR-031)", () => {
  it("template has the IMP-04 columns and never a password", () => {
    const [header] = TRAINEE_TEMPLATE_CSV.split("\r\n");
    expect(header.split(",").slice(0, 3)).toEqual(["Phone Number", "Full Name", "ITI Trade"]);
    expect(TRAINEE_TEMPLATE_CSV.toLowerCase()).not.toContain("password");
    expect(TRAINEE_TEMPLATE_CSV).not.toContain("Reedham");
  });

  it("derives the login status", () => {
    const base = { account: null } as unknown as Trainee;
    expect(loginStatus(base)).toBe("none");
    expect(loginStatus({ ...base, account: { user_id: "u", email: "e", must_change_password: true } })).toBe("default_password");
    expect(loginStatus({ ...base, account: { user_id: "u", email: "e", must_change_password: false } })).toBe("linked");
  });
});
