import { describe, expect, it } from 'vitest'
import {
  formatOperatingHours,
  formatPricing,
  formatTimeRange,
  is24HourRange,
  isUnsetTimeRange,
} from './parking-display'

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

// 리모트 D1 실측(2026-09-09)으로 확인한 다섯 가지 인코딩.
// 출처마다 24시간 표기가 달라서 한쪽만 알면 절반을 미상으로 흘린다.
const range = (start: string, end: string) => ({ start, end })

describe('운영시간 인코딩', () => {
  it('빈 값은 미상이다', () => {
    expect(isUnsetTimeRange(range('', ''))).toBe(true)
  })

  // 크롤러가 null 을 문자열로 써 넣은 행이 1,071곳 있다. 그대로 두면 「평일 null-null」이 나온다
  it('문자열 null 도 미상으로 본다', () => {
    expect(isUnsetTimeRange(range('null', 'null'))).toBe(true)
    expect(formatTimeRange(range('null', 'null'))).toBeNull()
  })

  // 공공데이터 sync 가 빈 칸을 "00:00" 으로 메운다 (sync-public-data.ts:190)
  it('시작과 끝이 둘 다 자정이면 미상이다', () => {
    expect(isUnsetTimeRange(range('00:00', '00:00'))).toBe(true)
  })

  // 예전엔 이 값을 미상으로 봐서 9,835곳이 「정보 없음」으로 나왔다.
  // MODU 는 상세페이지의 HH:MM ~ HH:MM 을 그대로 긁으므로 원본이 24시간이라고 말한 값이다.
  it('00:00-24:00 은 미상이 아니라 24시간 운영이다', () => {
    expect(isUnsetTimeRange(range('00:00', '24:00'))).toBe(false)
    expect(is24HourRange(range('00:00', '24:00'))).toBe(true)
    expect(formatTimeRange(range('00:00', '24:00'))).toBe('24시간')
  })

  // 공공데이터·카카오의 24시간 표기 (20,327곳)
  it('00:00-23:59 도 24시간 운영이다', () => {
    expect(is24HourRange(range('00:00', '23:59'))).toBe(true)
    expect(formatTimeRange(range('00:00', '23:59'))).toBe('24시간')
  })

  it('보통 시간대는 그대로 적는다', () => {
    expect(is24HourRange(range('09:00', '18:00'))).toBe(false)
    expect(formatTimeRange(range('09:00', '18:00'))).toBe('09:00-18:00')
  })
})

describe('formatOperatingHours', () => {
  it('세 요일이 모두 미상이면 미상이라고 말한다', () => {
    const r = formatOperatingHours({
      weekday: range('null', 'null'),
      saturday: range('', ''),
      holiday: range('00:00', '00:00'),
    })
    expect(r.isUnknown).toBe(true)
    expect(r.primary).not.toContain('null')
  })

  it('평일만 모르면 아는 요일을 대신 세운다', () => {
    const r = formatOperatingHours({
      weekday: range('', ''),
      saturday: range('10:00', '18:00'),
      holiday: range('', ''),
    })
    expect(r.isUnknown).toBe(false)
    expect(r.primary).toBe('토 10:00-18:00')
  })

  it('24시간 운영을 시각 대신 「24시간」으로 적는다', () => {
    const r = formatOperatingHours({
      weekday: range('00:00', '24:00'),
      saturday: range('00:00', '23:59'),
      holiday: range('', ''),
    })
    expect(r.primary).toBe('평일 24시간')
    expect(r.secondary).toBe('토 24시간')
  })
})
