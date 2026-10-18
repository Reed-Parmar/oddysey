import { describe, expect, it } from "vitest";

import { loginEmail, normalisePhone } from "./phone";

describe("phone login (ADR-031)", () => {
  it("normalises Indian mobile numbers", () => {
    expect(normalisePhone("+91 90000-00001")).toBe("+919000000001");
    expect(normalisePhone("919000000001")).toBe("+919000000001");
    expect(normalisePhone("09000000001")).toBe("+919000000001");
    expect(normalisePhone("(900) 000 0001")).toBe("+919000000001");
    for (const bad of ["12345", "5000000001", "+44 9000000001", "90000000012", "", "abc"]) expect(normalisePhone(bad)).toBeNull();
  });

  it("derives the login email from a phone and keeps emails as typed", () => {
    expect(loginEmail(" 90000 00001 ")).toBe("919000000001@trainee.spa.local");
    expect(loginEmail("asha@example.org ")).toBe("asha@example.org");
    expect(loginEmail("not a phone")).toBeNull();
  });
});
