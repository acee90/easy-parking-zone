import { describe, expect, it } from 'vitest'
import { buildDifficultyCondition } from '@/lib/filter-utils'
import type { ParkingFilters } from '@/types/parking'
import { DEFAULT_FILTERS } from '@/types/parking'

function makeFilters(overrides: Partial<ParkingFilters['difficulty']>): ParkingFilters {
  return {
    ...DEFAULT_FILTERS,
    difficulty: { ...DEFAULT_FILTERS.difficulty, ...overrides },
  }
}

const allOff = {
  easy: false,
  decent: false,
  normal: false,
  bad: false,
  hard: false,
  hell: false,
} as const

describe('buildDifficultyCondition', () => {
  it('returns empty string when no filters provided', () => {
    expect(buildDifficultyCondition()).toBe('')
  })

  it('returns empty string when all difficulty levels are ON', () => {
    expect(buildDifficultyCondition(DEFAULT_FILTERS)).toBe('')
  })

  it('filters only easy (4.0+)', () => {
    const filters = makeFilters({ ...allOff, easy: true })
    const result = buildDifficultyCondition(filters)
    expect(result).toContain('s.final_score >= 4.0')
    expect(result).not.toContain('s.final_score >= 3.3')
  })

  it('filters decent only (3.3-4.0)', () => {
    const filters = makeFilters({ ...allOff, decent: true })
    const result = buildDifficultyCondition(filters)
    expect(result).toContain('s.final_score >= 3.3')
    expect(result).toContain('s.final_score < 4.0')
  })

  it('filters normal only (2.7-3.3)', () => {
    const filters = makeFilters({ ...allOff, normal: true })
    const result = buildDifficultyCondition(filters)
    expect(result).toContain('s.final_score >= 2.7')
    expect(result).toContain('s.final_score < 3.3')
  })

  it('filters bad only (2.0-2.7)', () => {
    const filters = makeFilters({ ...allOff, bad: true })
    const result = buildDifficultyCondition(filters)
    expect(result).toContain('s.final_score >= 2.0')
    expect(result).toContain('s.final_score < 2.7')
  })

  it('filters hard only (1.5-2.0)', () => {
    const filters = makeFilters({ ...allOff, hard: true })
    const result = buildDifficultyCondition(filters)
    expect(result).toContain('s.final_score >= 1.5')
    expect(result).toContain('s.final_score < 2.0')
  })

  it('filters hell only (1.0-1.5)', () => {
    const filters = makeFilters({ ...allOff, hell: true })
    const result = buildDifficultyCondition(filters)
    expect(result).toContain('s.final_score >= 1.0')
    expect(result).toContain('s.final_score < 1.5')
  })

  it('combines multiple levels with OR', () => {
    const filters = makeFilters({ ...allOff, easy: true, hard: true })
    const result = buildDifficultyCondition(filters)
    expect(result).toContain('OR')
    expect(result).toContain('s.final_score >= 4.0')
    expect(result).toContain('s.final_score >= 1.5')
  })

  it("returns '0' when all levels are OFF", () => {
    const filters = makeFilters(allOff)
    expect(buildDifficultyCondition(filters)).toBe('0')
  })

  it('uses custom score column name', () => {
    const filters = makeFilters({ ...allOff, easy: true })
    const result = buildDifficultyCondition(filters, 'custom.score')
    expect(result).toContain('custom.score >= 4.0')
    expect(result).not.toContain('(s.final_score')
  })
})
