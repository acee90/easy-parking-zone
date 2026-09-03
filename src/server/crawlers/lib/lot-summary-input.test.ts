import { describe, expect, it } from 'vitest'
import { WEB_PER_REVIEW, webQuotaFor } from './lot-summary-input'

describe('webQuotaFor — 근거 배분 기준', () => {
  it('리뷰가 없으면 웹 요약을 최대치까지 쓴다', () => {
    expect(webQuotaFor(0)).toBe(30)
  })

  it('리뷰 1건이면 웹을 4건으로 깎는다 — 실측 최악값 21:1 이 4:1 이 된다', () => {
    expect(webQuotaFor(1)).toBe(4)
  })

  it('리뷰가 늘면 웹 허용치도 비례해 는다', () => {
    expect(webQuotaFor(2)).toBe(8)
    expect(webQuotaFor(5)).toBe(20)
  })

  it('웹 상한을 넘지 않는다', () => {
    expect(webQuotaFor(100)).toBe(30)
  })

  it('핵심 약속 — 리뷰가 있으면 웹 비중이 항상 4배 이하다', () => {
    for (const rv of [1, 2, 3, 5, 10, 20, 50]) {
      expect(webQuotaFor(rv) / rv).toBeLessThanOrEqual(WEB_PER_REVIEW)
    }
  })

  it('웹 근거가 아예 없어지지는 않는다', () => {
    expect(webQuotaFor(1)).toBeGreaterThanOrEqual(4)
  })
})
