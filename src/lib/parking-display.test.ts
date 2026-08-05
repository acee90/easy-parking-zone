import { describe, expect, it } from 'vitest'
import { formatPricing } from './parking-display'

type Pricing = Parameters<typeof formatPricing>[0]

const base: Pricing = {
  isFree: false,
  baseTime: 30,
  baseFee: 1000,
  extraTime: 10,
  extraFee: 500,
  dailyMax: null,
}

describe('formatPricing', () => {
  it('무료면 무료만 표시한다', () => {
    expect(formatPricing({ ...base, isFree: true }).primary).toBe('무료')
  })

  it('요금 정보가 전혀 없으면 미상으로 표시한다', () => {
    const r = formatPricing({ ...base, baseTime: 0, baseFee: 0 })
    expect(r.isUnknown).toBe(true)
  })

  it('기본요금이 있으면 기본 N분 M원으로 표시한다', () => {
    const r = formatPricing(base)
    expect(r.primary).toBe('기본 30분 1,000원')
    expect(r.secondary).toBe('추가 10분당 500원')
  })

  // 현대백화점 대구점(KA-39895623)처럼 "최초 30분 무료 + 초과 10분당 1,000원" 정책.
  // 이전에는 "기본 30분 0원"으로 렌더돼 읽기 어려웠다.
  it('기본요금이 0원이면 최초 N분 무료로 표시한다', () => {
    const r = formatPricing({ ...base, baseFee: 0, extraTime: 10, extraFee: 1000 })
    expect(r.primary).toBe('최초 30분 무료')
    expect(r.secondary).toBe('추가 10분당 1,000원')
    expect(r.isUnknown).toBe(false)
  })

  it('1일 최대 요금이 있으면 함께 표시한다', () => {
    const r = formatPricing({ ...base, dailyMax: 15000 })
    expect(r.secondary).toBe('추가 10분당 500원 · 1일 최대 15,000원')
  })
})
