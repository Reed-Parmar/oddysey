import { describe, expect, it } from "vitest";

import { formatIst, fromLocalInput, humanize, toLocalInput, triggerLabel } from "./common";

describe("Asia/Kolkata datetime helpers", () => {
  it("shows an instant as IST wall time in datetime-local inputs", () => {
    expect(toLocalInput("2026-10-18T12:30:00Z")).toBe("2026-10-18T18:00");
    expect(toLocalInput("2026-10-18T20:00:00Z")).toBe("2026-10-19T01:30");
    expect(toLocalInput(null)).toBe("");
  });

  it("sends input values as IST with an explicit offset", () => {
    expect(fromLocalInput("2026-10-18T18:00")).toBe("2026-10-18T18:00:00+05:30");
    expect(new Date(fromLocalInput("2026-10-18T18:00")).toISOString()).toBe("2026-10-18T12:30:00.000Z");
  });

  it("round-trips", () => {
    const iso = "2026-12-31T23:59:00.000Z";
    expect(new Date(fromLocalInput(toLocalInput(iso))).toISOString()).toBe(iso);
  });

  it("formats with an IST suffix", () => {
    expect(formatIst("2026-10-18T12:30:00Z")).toMatch(/IST$/);
    expect(formatIst(undefined)).toBe("—");
  });
});

describe("labels", () => {
  it("labels allocation triggers without recommendation wording", () => {
    expect(triggerLabel("schedule")).toBe("Scheduled run");
    expect(triggerLabel("something_new")).toBe("Something new");
    expect(triggerLabel(null)).toBe("—");
    expect(humanize("needs_attention")).toBe("Needs attention");
  });
});
