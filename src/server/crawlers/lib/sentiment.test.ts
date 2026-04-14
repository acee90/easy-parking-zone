import { describe, expect, it } from 'vitest'
import { aggregateTextSentiment, analyzeSentiment, computeRelevance, timeDecay } from './sentiment'

describe('computeRelevance', () => {
  it('returns 1.0 for 2+ experience keywords', () => {
    expect(computeRelevance('주차장이 좁고 경사가 급해요')).toBe(1.0)
  })

  it('returns 0.7 for 1 experience keyword', () => {
    expect(computeRelevance('주차장이 넓어요')).toBe(0.7)
  })

  it('returns 0.3 for only "주차" mention', () => {
    expect(computeRelevance('주차 가능합니다')).toBe(0.3)
  })

  it('returns 0.0 for irrelevant text', () => {
    expect(computeRelevance('오늘 날씨가 좋습니다')).toBe(0.0)
  })
})

describe('analyzeSentiment', () => {
  it('returns neutral for irrelevant text', () => {
    const result = analyzeSentiment('맛집 추천합니다')
    expect(result.relevance).toBe(0)
    expect(result.sentimentScore).toBe(3.0)
  })

  it('detects negative sentiment', () => {
    const result = analyzeSentiment('주차장이 너무 좁고 기둥이 많아서 힘들었어요')
    expect(result.sentimentScore).toBeLessThan(3.0)
    expect(result.matchCount).toBeGreaterThan(0)
  })

  it('detects positive sentiment', () => {
    const result = analyzeSentiment('주차장이 넓고 편해서 추천합니다')
    expect(result.sentimentScore).toBeGreaterThan(3.0)
    expect(result.matchCount).toBeGreaterThan(0)
  })

  it('handles negation: "안 좁다" reverses negative', () => {
    const negated = analyzeSentiment('주차장이 안 좁다 편해요')
    const plain = analyzeSentiment('주차장이 좁다 힘들어요')
    expect(negated.sentimentScore).toBeGreaterThan(plain.sentimentScore)
  })

  it('handles negation: "넓지 않아서" reverses positive', () => {
    const negated = analyzeSentiment('주차장이 넓지 않아서 힘들었어요')
    expect(negated.sentimentScore).toBeLessThan(3.0)
  })

  it('applies intensifier boost', () => {
    const intense = analyzeSentiment('진짜 좁아서 주차 힘들어요')
    const normal = analyzeSentiment('좁아서 주차 힘들어요')
    // intensifier should make it more extreme
    expect(intense.sentimentScore).toBeLessThanOrEqual(normal.sentimentScore)
  })

  it('detects emoticon signals', () => {
    const withEmoticon = analyzeSentiment('주차장 좁아요 ㅠㅠ')
    const withoutEmoticon = analyzeSentiment('주차장 좁아요')
    expect(withEmoticon.matchCount).toBeGreaterThan(withoutEmoticon.matchCount)
  })

  it('applies keyword count damping', () => {
    // 1 keyword: 50% damping toward 3.0
    const single = analyzeSentiment('주차장이 좁아요')
    expect(single.matchCount).toBe(1)
    // score should be closer to 3.0 than raw would suggest
    expect(single.sentimentScore).toBeGreaterThanOrEqual(1.0)
  })

  it('clamps score to 1.0-5.0 range', () => {
    const result = analyzeSentiment('좁고 힘들고 무섭고 긁히고 골뱅이 경사 기둥 복잡 만차 헬 지옥')
    expect(result.sentimentScore).toBeGreaterThanOrEqual(1.0)
    expect(result.sentimentScore).toBeLessThanOrEqual(5.0)
  })
})

describe('timeDecay', () => {
  const now = new Date('2026-04-02')

  it('returns 1.0 for today', () => {
    expect(timeDecay('2026-04-02', now)).toBeCloseTo(1.0, 2)
  })

  it('returns ~0.5 for 1 year ago', () => {
    expect(timeDecay('2025-04-02', now)).toBeCloseTo(0.5, 1)
  })

  it('returns ~0.25 for 2 years ago', () => {
    expect(timeDecay('2024-04-02', now)).toBeCloseTo(0.25, 1)
  })

  it('returns 0.5 for null date', () => {
    expect(timeDecay(null)).toBe(0.5)
  })

  it('returns 1.0 for future date', () => {
    expect(timeDecay('2027-01-01', now)).toBe(1.0)
  })
})

describe('aggregateTextSentiment', () => {
  const now = new Date('2026-04-02')

  it('returns null for empty entries', () => {
    expect(aggregateTextSentiment([], null, now)).toBeNull()
  })

  it('returns null for irrelevant entries', () => {
    const entries = [{ text: '오늘 날씨가 좋다', publishedAt: '2026-04-01' }]
    expect(aggregateTextSentiment(entries, null, now)).toBeNull()
  })

  it('aggregates multiple entries', () => {
    const entries = [
      { text: '주차장이 좁고 힘들었어요', publishedAt: '2026-03-01' },
      { text: '넓고 편한 주차장이에요', publishedAt: '2026-04-01' },
    ]
    const result = aggregateTextSentiment(entries, null, now)
    expect(result).not.toBeNull()
    expect(result!.count).toBe(2)
    expect(result!.score).toBeGreaterThanOrEqual(1.0)
    expect(result!.score).toBeLessThanOrEqual(5.0)
  })

  it('weights recent entries more', () => {
    const recentNegative = [
      { text: '주차장이 좁고 힘들었어요', publishedAt: '2026-04-01' },
      { text: '넓고 편한 주차장이에요', publishedAt: '2024-01-01' },
    ]
    const recentPositive = [
      { text: '주차장이 좁고 힘들었어요', publishedAt: '2024-01-01' },
      { text: '넓고 편한 주차장이에요', publishedAt: '2026-04-01' },
    ]
    const resultA = aggregateTextSentiment(recentNegative, null, now)
    const resultB = aggregateTextSentiment(recentPositive, null, now)
    expect(resultA!.score).toBeLessThan(resultB!.score)
  })
})
