import { describe, expect, it } from 'vitest'
import type { ParkingLot } from '@/types/parking'
import { getParkingDetailSeoSignalCount, shouldIndexParkingDetail } from './seo-indexing'

function makeLot(overrides: Partial<ParkingLot> = {}): ParkingLot {
  return {
    id: 'KA-1',
    name: '테스트 주차장',
    type: '부설',
    address: '서울시 강남구 테스트로 1',
    lat: 37.5,
    lng: 127,
    totalSpaces: 0,
    operatingHours: {
      weekday: { start: '00:00', end: '00:00' },
      saturday: { start: '00:00', end: '00:00' },
      holiday: { start: '00:00', end: '00:00' },
    },
    pricing: {
      isFree: false,
      baseTime: 0,
      baseFee: 0,
      extraTime: 0,
      extraFee: 0,
    },
    difficulty: {
      score: null,
      reviewCount: 0,
      reliability: 'none',
    },
    ...overrides,
  }
}

describe('shouldIndexParkingDetail', () => {
  it('외부 콘텐츠가 있으면 기본 정보가 적어도 색인 허용', () => {
    expect(shouldIndexParkingDetail(makeLot(), { reviews: 0, blog: 1, media: 0 })).toBe(true)
  })

  it('AI 요약이나 큐레이션 문구가 있으면 색인 허용', () => {
    expect(
      shouldIndexParkingDetail(makeLot({ aiSummary: '방문 전 참고할 만한 주차 팁입니다.' }), {
        reviews: 0,
        blog: 0,
        media: 0,
      }),
    ).toBe(true)
  })

  it('구조화 기본 정보가 3개 이상이면 색인 허용', () => {
    const lot = makeLot({
      totalSpaces: 120,
      operatingHours: {
        weekday: { start: '09:00', end: '18:00' },
        saturday: { start: '00:00', end: '00:00' },
        holiday: { start: '00:00', end: '00:00' },
      },
      pricing: {
        isFree: false,
        baseTime: 30,
        baseFee: 1000,
        extraTime: 10,
        extraFee: 500,
      },
    })

    expect(getParkingDetailSeoSignalCount(lot)).toBe(3)
    expect(shouldIndexParkingDetail(lot, { reviews: 0, blog: 0, media: 0 })).toBe(true)
  })

  it('이름/주소/좌표뿐인 thin 상세는 noindex 유지', () => {
    expect(shouldIndexParkingDetail(makeLot(), { reviews: 0, blog: 0, media: 0 })).toBe(false)
  })
})
