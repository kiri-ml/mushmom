import { describe, expect, it } from "vitest";
import { currentUtcMonthKey, isMonthKey, monthKeysAfter, nextMonthKey } from "../src/stats-months";

describe("stats month keys", () => {
  it("validates canonical month keys", () => {
    expect(isMonthKey("2026-07")).toBe(true);
    expect(isMonthKey("2026-7")).toBe(false);
    expect(isMonthKey("2026-13")).toBe(false);
  });

  it("increments across year boundaries", () => {
    expect(nextMonthKey("2026-11")).toBe("2026-12");
    expect(nextMonthKey("2026-12")).toBe("2027-01");
  });

  it("returns every month after the archive through the inclusive end", () => {
    expect(monthKeysAfter("2026-11", "2027-02")).toEqual([
      "2026-12",
      "2027-01",
      "2027-02",
    ]);
    expect(monthKeysAfter("2027-02", "2027-02")).toEqual([]);
  });

  it("uses UTC for the current month", () => {
    expect(currentUtcMonthKey(new Date("2026-08-01T00:00:00.000Z"))).toBe("2026-08");
  });
});
