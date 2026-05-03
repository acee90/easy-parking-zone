import { describe, expect, it } from 'vitest'
import { MIN_SUMMARY_LENGTH, toResult } from './ai-filter'

describe('MIN_SUMMARY_LENGTH', () => {
  it('is 200', () => {
    expect(MIN_SUMMARY_LENGTH).toBe(200)
  })
})

describe('toResult — short_summary 후처리', () => {
  it('LLM이 filter_passed=true 반환했어도 summary가 200자 미만이면 filter_passed=false', () => {
    const r = toResult({
      filter_passed: true,
      removed_by: null,
      summary: 'a'.repeat(100),
      sentiment_score: 4.0,
      difficulty_keywords: ['좁다'],
    })
    expect(r.filterPassed).toBe(false)
    expect(r.filterRemovedBy).toBe('short_summary')
    expect(r.summary.length).toBe(100)
  })

  it('summary가 정확히 200자면 통과', () => {
    const r = toResult({
      filter_passed: true,
      removed_by: null,
      summary: 'a'.repeat(200),
      sentiment_score: 3.5,
      difficulty_keywords: [],
    })
    expect(r.filterPassed).toBe(true)
    expect(r.filterRemovedBy).toBeNull()
  })

  it('summary가 200자 초과면 통과', () => {
    const r = toResult({
      filter_passed: true,
      removed_by: null,
      summary: 'a'.repeat(450),
      sentiment_score: 3.0,
      difficulty_keywords: [],
    })
    expect(r.filterPassed).toBe(true)
    expect(r.filterRemovedBy).toBeNull()
  })

  it('summary가 빈 문자열이면 short_summary로 거부', () => {
    const r = toResult({
      filter_passed: true,
      summary: '',
      sentiment_score: 3.0,
    })
    expect(r.filterPassed).toBe(false)
    expect(r.filterRemovedBy).toBe('short_summary')
  })

  it('LLM이 filter_passed=false 반환하고 summary도 짧으면 short_summary 우선', () => {
    const r = toResult({
      filter_passed: false,
      removed_by: 'ad',
      summary: 'short',
      sentiment_score: 3.0,
    })
    expect(r.filterPassed).toBe(false)
    // short_summary가 ad보다 우선 (summary 길이가 결정 요인이므로)
    expect(r.filterRemovedBy).toBe('short_summary')
  })

  it('LLM이 filter_passed=false 반환하고 summary가 충분히 길면 LLM의 removed_by 유지', () => {
    const r = toResult({
      filter_passed: false,
      removed_by: 'ad',
      summary: 'a'.repeat(250),
      sentiment_score: 3.0,
    })
    expect(r.filterPassed).toBe(false)
    expect(r.filterRemovedBy).toBe('ad')
  })

  it('removed_by가 누락되고 filter_passed=false, summary 길면 unknown', () => {
    const r = toResult({
      filter_passed: false,
      summary: 'a'.repeat(250),
      sentiment_score: 3.0,
    })
    expect(r.filterPassed).toBe(false)
    expect(r.filterRemovedBy).toBe('unknown')
  })
})

describe('toResult — 기본 필드 매핑', () => {
  it('difficulty_keywords가 배열이 아니면 빈 배열', () => {
    const r = toResult({
      filter_passed: true,
      summary: 'a'.repeat(250),
      sentiment_score: 3.5,
    })
    expect(r.difficultyKeywords).toEqual([])
  })

  it('sentiment_score는 1.0~5.0으로 클램프', () => {
    const r1 = toResult({
      filter_passed: true,
      summary: 'a'.repeat(250),
      sentiment_score: 10,
    })
    expect(r1.sentimentScore).toBe(5.0)

    const r2 = toResult({
      filter_passed: true,
      summary: 'a'.repeat(250),
      sentiment_score: -1,
    })
    expect(r2.sentimentScore).toBe(1.0)
  })

  it('sentiment_score가 누락되면 3.0', () => {
    const r = toResult({
      filter_passed: true,
      summary: 'a'.repeat(250),
    })
    expect(r.sentimentScore).toBe(3.0)
  })

  it('tip 필드는 falsy면 null', () => {
    const r = toResult({
      filter_passed: true,
      summary: 'a'.repeat(250),
      sentiment_score: 3.0,
      tip_pricing: null,
      tip_visit: '',
      tip_alternative: '인근 공영주차장',
    })
    expect(r.tipPricing).toBeNull()
    expect(r.tipVisit).toBeNull()
    expect(r.tipAlternative).toBe('인근 공영주차장')
  })
})
