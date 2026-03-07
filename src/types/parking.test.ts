import { describe, it, expect } from "vitest";
import { DEFAULT_FILTERS, DEFAULT_DIFFICULTY } from "./parking";
import type { DifficultyFilter, ParkingFilters } from "./parking";

describe("DEFAULT_FILTERS", () => {
  it("has all boolean filters off by default", () => {
    expect(DEFAULT_FILTERS.freeOnly).toBe(false);
    expect(DEFAULT_FILTERS.publicOnly).toBe(false);
    expect(DEFAULT_FILTERS.excludeNoSang).toBe(false);
  });

  it("has all difficulty levels ON by default", () => {
    const d = DEFAULT_FILTERS.difficulty;
    expect(d.easy).toBe(true);
    expect(d.normal).toBe(true);
    expect(d.hard).toBe(true);
    expect(d.hell).toBe(true);
    expect(d.noReview).toBe(true);
  });
});

describe("DEFAULT_DIFFICULTY", () => {
  it("is independent from DEFAULT_FILTERS.difficulty (no reference sharing)", () => {
    const a = { ...DEFAULT_DIFFICULTY };
    a.easy = false;
    expect(DEFAULT_FILTERS.difficulty.easy).toBe(true);
  });
});

describe("DifficultyFilter type", () => {
  it("has exactly 5 keys", () => {
    const keys: (keyof DifficultyFilter)[] = [
      "easy",
      "normal",
      "hard",
      "hell",
      "noReview",
    ];
    expect(keys).toHaveLength(5);
    for (const key of keys) {
      expect(typeof DEFAULT_DIFFICULTY[key]).toBe("boolean");
    }
  });
});
