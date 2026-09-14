import { describe, expect, it } from 'vitest'
import { computeRegionStats, districtOf, type RegionStatsRow } from './region-stats'

const base: RegionStatsRow = {
  type: '노외',
  is_free: 0,
  total_spaces: 50,
  weekday_start: '09:00',
  weekday_end: '18:00',
  base_time: 30,
  base_fee: 1000,
  extra_time: 10,
  extra_fee: 500,
  daily_max: null,
  address: '대전광역시 서구 둔산동 1',
}

describe('districtOf', () => {
  it('주소 두 번째 토큰이 시·군·구면 그 이름', () => {
    expect(districtOf('대전광역시 서구 둔산동 1', ['대전'])).toBe('서구')
    expect(districtOf('경기 성남시 분당구 1', ['경기'])).toBe('성남시')
  })

  it('광역명이 다시 나오거나 시·군·구가 아니면 null', () => {
    expect(districtOf('서울 서울특별시 중구 1', ['서울'])).toBeNull()
    expect(districtOf('세종특별자치시 조치원읍 1', ['세종'])).toBeNull()
    expect(districtOf(null, ['서울'])).toBeNull()
  })
})

describe('computeRegionStats', () => {
  const rows: RegionStatsRow[] = [
    // 30분 1000 + 10분당 500 → 1시간 2,500원, 24시간
    { ...base, weekday_start: '00:00', weekday_end: '24:00' },
    // 무료 부설, 대형, 운영시간 미상 (문자열 'null')
    {
      ...base,
      type: '부설',
      is_free: 1,
      total_spaces: 300,
      weekday_start: 'null',
      weekday_end: 'null',
      base_fee: 0,
      extra_fee: 0,
    },
    // 노상, 추가 요금 없음 → 1시간 요금 계산 불가, 미상 자정-자정
    {
      ...base,
      type: '노상',
      extra_time: null,
      extra_fee: null,
      weekday_start: '00:00',
      weekday_end: '00:00',
      address: '대전광역시 중구 대흥동 2',
    },
    // 60분 3,000원, 공공데이터식 24시간
    {
      ...base,
      base_time: 60,
      base_fee: 3000,
      weekday_start: '00:00',
      weekday_end: '23:59',
      address: '대전광역시 중구 대흥동 3',
    },
  ]
  const stats = computeRegionStats(rows, ['대전'])

  it('유형·무료·대형 곳수', () => {
    expect(stats).toMatchObject({
      total: 4,
      outdoor: 2,
      attached: 1,
      onStreet: 1,
      free: 1,
      large: 1,
    })
  })

  it('1시간 요금은 계산 가능한 유료 lot 만, 중앙값', () => {
    expect(stats.feeCount).toBe(2)
    expect(stats.feeMedian).toBe(2750)
  })

  it('24시간은 운영시간이 확인된 lot 중에서만 센다 (00:00-24:00 · 00:00-23:59 둘 다)', () => {
    expect(stats.hoursKnown).toBe(2)
    expect(stats.hours24).toBe(2)
  })

  it('구·시·군별로 곳수가 많은 순', () => {
    expect(stats.districts).toEqual([
      { name: '서구', count: 2, free: 1, feeMedian: 2500, feeCount: 1 },
      { name: '중구', count: 2, free: 0, feeMedian: 3000, feeCount: 1 },
    ])
  })
})
