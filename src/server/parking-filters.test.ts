import { describe, it, expect } from "vitest";
import { buildDifficultyCondition } from "@/lib/filter-utils";
import type { ParkingFilters } from "@/types/parking";
import { DEFAULT_FILTERS } from "@/types/parking";

function makeFilters(
  overrides: Partial<ParkingFilters["difficulty"]>
): ParkingFilters {
  return {
    ...DEFAULT_FILTERS,
    difficulty: { ...DEFAULT_FILTERS.difficulty, ...overrides },
  };
}

describe("buildDifficultyCondition", () => {
  it("returns empty string when no filters provided", () => {
    expect(buildDifficultyCondition()).toBe("");
  });

  it("returns empty string when all difficulty levels are ON", () => {
    expect(buildDifficultyCondition(DEFAULT_FILTERS)).toBe("");
  });

  it("filters only easy (4.0+)", () => {
    const filters = makeFilters({
      easy: true,
      normal: false,
      hard: false,
      hell: false,
      noReview: false,
    });
    const result = buildDifficultyCondition(filters);
    expect(result).toContain("s.final_score >= 4.0");
    expect(result).not.toContain("s.final_score >= 2.5");
  });

  it("filters hell only (1.0-1.5)", () => {
    const filters = makeFilters({
      easy: false,
      normal: false,
      hard: false,
      hell: true,
      noReview: false,
    });
    const result = buildDifficultyCondition(filters);
    expect(result).toContain("s.final_score >= 1.0");
    expect(result).toContain("s.final_score < 1.5");
  });

  it("filters noReview (IS NULL)", () => {
    const filters = makeFilters({
      easy: false,
      normal: false,
      hard: false,
      hell: false,
      noReview: true,
    });
    const result = buildDifficultyCondition(filters);
    expect(result).toContain("IS NULL");
  });

  it("combines multiple levels with OR", () => {
    const filters = makeFilters({
      easy: true,
      normal: false,
      hard: true,
      hell: false,
      noReview: false,
    });
    const result = buildDifficultyCondition(filters);
    expect(result).toContain("OR");
    expect(result).toContain("s.final_score >= 4.0");
    expect(result).toContain("s.final_score >= 1.5");
  });

  it("returns '0' when all levels are OFF", () => {
    const filters = makeFilters({
      easy: false,
      normal: false,
      hard: false,
      hell: false,
      noReview: false,
    });
    expect(buildDifficultyCondition(filters)).toBe("0");
  });

  it("uses custom score column name", () => {
    const filters = makeFilters({
      easy: true,
      normal: false,
      hard: false,
      hell: false,
      noReview: false,
    });
    const result = buildDifficultyCondition(filters, "custom.score");
    expect(result).toContain("custom.score >= 4.0");
    expect(result).not.toContain("(s.final_score");
  });
});
