import { describe, expect, it } from 'vitest'
import {
  computeFinalScore,
  computeSourceScores,
  computeStructuralPrior,
  SCORE_PARAMS,
} from './scoring-engine-core'

describe('scoring-engine-core', () => {
  it('구조 prior만 있으면 final score가 prior로 수렴', () => {
    const prior = computeStructuralPrior({
      name: '기계식 소형 주차장',
      type: '부설',
      total_spaces: 20,
      is_free: 0,
      notes: null,
    })

    const result = computeFinalScore(prior, {
      reviewScore: null,
      reviewCount: 0,
      webScore: null,
      webCount: 0,
      nEffective: 0,
    })

    expect(result.finalScore).toBeCloseTo(prior, 1)
    expect(result.reliability).toBe('structural')
  })

  it('리뷰 1건 5점은 Bayesian prior로 과대평가를 억제', () => {
    const sources = computeSourceScores(
      [
        {
          overall_score: 5,
          is_seed: 0,
          source_type: null,
          created_at: '2026-05-23T00:00:00Z',
        },
      ],
      [],
      new Date('2026-05-23T00:00:00Z'),
    )

    const result = computeFinalScore(3, sources)

    expect(sources.reviewScore).toBe(5)
    expect(sources.reviewCount).toBe(1)
    expect(sources.nEffective).toBe(3)
    expect(result.finalScore).toBe(4.09)
  })

  it('리뷰와 웹소스는 0.6 / 0.4 기본 weight로 통합', () => {
    const result = computeFinalScore(3, {
      reviewScore: 5,
      reviewCount: 10,
      webScore: 2,
      webCount: 10,
      nEffective: 10,
    })

    const rawSignal = SCORE_PARAMS.SOURCE_WEIGHTS.review * 5 + SCORE_PARAMS.SOURCE_WEIGHTS.web * 2
    const expected = (SCORE_PARAMS.PRIOR_C * 3 + 10 * rawSignal) / (SCORE_PARAMS.PRIOR_C + 10)

    expect(result.finalScore).toBe(Math.round(expected * 100) / 100)
  })

  it('seed/source 리뷰는 review_score에 통합하되 내부 weight를 낮춘다', () => {
    const sources = computeSourceScores(
      [
        {
          overall_score: 5,
          is_seed: 0,
          source_type: null,
          created_at: '2026-05-23T00:00:00Z',
        },
        {
          overall_score: 1,
          is_seed: 1,
          source_type: null,
          created_at: '2026-05-23T00:00:00Z',
        },
        {
          overall_score: 1,
          is_seed: 0,
          source_type: 'clien',
          created_at: '2026-05-23T00:00:00Z',
        },
      ],
      [],
      new Date('2026-05-23T00:00:00Z'),
    )

    expect(sources.reviewCount).toBe(3)
    expect(sources.nEffective).toBe(3.9)
    expect(sources.reviewScore).toBe(4.08)
  })
})
