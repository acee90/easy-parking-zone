import { describe, expect, it } from 'vitest'
import type { ParkingLot } from '@/types/parking'
import {
  applyFieldEdit,
  type FeePayload,
  type HoursPayload,
  isFieldGroupEmpty,
  parseFieldPayload,
  validateFieldPayload,
} from './lot-field-groups'

function makeLot(over: Partial<ParkingLot> = {}): ParkingLot {
  return {
    id: 'KA-1',
    name: '테스트 주차장',
    type: '노외',
    address: '서울시 어딘가',
    lat: 37.5,
    lng: 127,
    totalSpaces: 100,
    phone: null,
    pricing: { isFree: false, baseTime: 30, baseFee: 1000, extraTime: 15, extraFee: 500 },
    difficulty: { score: 3, reviewCount: 0, reliability: 'none' },
    operatingHours: {
      weekday: { start: '09:00', end: '21:00' },
      saturday: { start: '09:00', end: '21:00' },
      holiday: { start: '09:00', end: '21:00' },
    },
    ...over,
  } as ParkingLot
}

const NO_FEE = { isFree: false, baseTime: 0, baseFee: 0, extraTime: 0, extraFee: 0 }
const NO_HOURS = {
  weekday: { start: '', end: '' },
  saturday: { start: '', end: '' },
  holiday: { start: '', end: '' },
}

describe('isFieldGroupEmpty', () => {
  it('요금표가 있으면 비어 있지 않다', () => {
    expect(isFieldGroupEmpty(makeLot(), 'fee')).toBe(false)
  })

  it('무료는 아는 값이다 — 비어 있지 않다', () => {
    expect(isFieldGroupEmpty(makeLot({ pricing: { ...NO_FEE, isFree: true } }), 'fee')).toBe(false)
  })

  it('유료인데 시간당도 1일 최대도 모르면 비어 있다', () => {
    expect(isFieldGroupEmpty(makeLot({ pricing: NO_FEE }), 'fee')).toBe(true)
  })

  // 히어로 요금 칸이 1일 최대를 대신 세우는 127곳. 화면에 값이 있으니 빈 칸이 아니다
  it('1일 최대만 알아도 비어 있지 않다', () => {
    expect(isFieldGroupEmpty(makeLot({ pricing: { ...NO_FEE, dailyMax: 20000 } }), 'fee')).toBe(
      false,
    )
  })

  it('세 요일이 모두 미상일 때만 운영시간이 비어 있다', () => {
    expect(isFieldGroupEmpty(makeLot(), 'hours')).toBe(false)
    expect(isFieldGroupEmpty(makeLot({ operatingHours: NO_HOURS }), 'hours')).toBe(true)
    // 평일만 알아도 화면에 값이 선다
    expect(
      isFieldGroupEmpty(
        makeLot({ operatingHours: { ...NO_HOURS, weekday: { start: '09:00', end: '18:00' } } }),
        'hours',
      ),
    ).toBe(false)
  })

  // 24시간 인코딩을 미상으로 보던 시절엔 여기가 true 였다 (9,835곳)
  it('00:00-24:00 은 아는 값이다', () => {
    const hours = {
      weekday: { start: '00:00', end: '24:00' },
      saturday: { start: '00:00', end: '24:00' },
      holiday: { start: '00:00', end: '24:00' },
    }
    expect(isFieldGroupEmpty(makeLot({ operatingHours: hours }), 'hours')).toBe(false)
  })

  it('주차면 0은 비어 있다', () => {
    expect(isFieldGroupEmpty(makeLot({ totalSpaces: 0 }), 'spaces')).toBe(true)
    expect(isFieldGroupEmpty(makeLot({ totalSpaces: 120 }), 'spaces')).toBe(false)
  })
})

describe('validateFieldPayload', () => {
  it('무료를 고르면 요금 컬럼을 모두 비운다', () => {
    const p = validateFieldPayload('fee', { isFree: true, baseFee: 3000 }) as FeePayload
    expect(p).toEqual({
      isFree: true,
      baseTime: 0,
      baseFee: 0,
      extraTime: 0,
      extraFee: 0,
      dailyMax: null,
    })
  })

  it('유료인데 요금이 하나도 없으면 거절한다', () => {
    expect(() => validateFieldPayload('fee', { isFree: false, baseTime: 30, baseFee: 0 })).toThrow()
  })

  it('추가 요금은 선택이다 — 정액제는 기본 요금만 있다', () => {
    const p = validateFieldPayload('fee', {
      isFree: false,
      baseTime: 1440,
      baseFee: 10000,
    }) as FeePayload
    expect(p.extraTime).toBe(0)
    expect(p.dailyMax).toBeNull()
  })

  it('1일 최대가 기본 요금보다 적으면 거절한다', () => {
    expect(() =>
      validateFieldPayload('fee', { isFree: false, baseTime: 30, baseFee: 5000, dailyMax: 3000 }),
    ).toThrow()
  })

  it('말도 안 되는 금액을 막는다', () => {
    expect(() =>
      validateFieldPayload('fee', { isFree: false, baseTime: 30, baseFee: 9_999_999 }),
    ).toThrow()
    expect(() =>
      validateFieldPayload('fee', { isFree: false, baseTime: 30, baseFee: -100 }),
    ).toThrow()
  })

  it('토·공휴일을 안 보내면 평일과 같다고 본다', () => {
    const p = validateFieldPayload('hours', {
      weekday: { start: '09:00', end: '18:00' },
    }) as HoursPayload
    expect(p.saturday).toEqual({ start: '09:00', end: '18:00' })
    expect(p.holiday).toEqual({ start: '09:00', end: '18:00' })
  })

  it('24:00 을 끝 시각으로 받는다', () => {
    const p = validateFieldPayload('hours', {
      weekday: { start: '00:00', end: '24:00' },
    }) as HoursPayload
    expect(p.weekday.end).toBe('24:00')
  })

  it('시작과 끝이 같으면 거절한다 — 휴무인지 24시간인지 알 수 없다', () => {
    expect(() =>
      validateFieldPayload('hours', { weekday: { start: '09:00', end: '09:00' } }),
    ).toThrow()
  })

  it('시각 형식이 아니면 거절한다', () => {
    expect(() =>
      validateFieldPayload('hours', { weekday: { start: '9시', end: '18:00' } }),
    ).toThrow()
    expect(() =>
      validateFieldPayload('hours', { weekday: { start: '25:00', end: '26:00' } }),
    ).toThrow()
  })

  it('주차면은 1 이상 정수만 받는다', () => {
    expect(validateFieldPayload('spaces', { totalSpaces: 42 })).toEqual({ totalSpaces: 42 })
    expect(() => validateFieldPayload('spaces', { totalSpaces: 0 })).toThrow()
    expect(() => validateFieldPayload('spaces', { totalSpaces: 12.5 })).toThrow()
  })
})

describe('applyFieldEdit', () => {
  it('요금을 얹어도 원본 객체를 바꾸지 않는다', () => {
    const lot = makeLot()
    const next = applyFieldEdit(lot, 'fee', {
      isFree: true,
      baseTime: 0,
      baseFee: 0,
      extraTime: 0,
      extraFee: 0,
      dailyMax: null,
    })
    expect(next.pricing.isFree).toBe(true)
    expect(lot.pricing.isFree).toBe(false)
  })

  it('운영시간을 통째로 갈아끼운다', () => {
    const next = applyFieldEdit(makeLot(), 'hours', {
      weekday: { start: '00:00', end: '24:00' },
      saturday: { start: '00:00', end: '24:00' },
      holiday: { start: '00:00', end: '24:00' },
    })
    expect(next.operatingHours.weekday.end).toBe('24:00')
  })

  it('주차면을 바꾼다', () => {
    expect(applyFieldEdit(makeLot(), 'spaces', { totalSpaces: 7 }).totalSpaces).toBe(7)
  })
})

describe('parseFieldPayload', () => {
  it('깨진 JSON 은 null 로 넘긴다 — 상세페이지가 죽으면 안 된다', () => {
    expect(parseFieldPayload('spaces', '{{{')).toBeNull()
    expect(parseFieldPayload('spaces', '{"totalSpaces":-1}')).toBeNull()
  })

  it('정상 payload 는 되살린다', () => {
    expect(parseFieldPayload('spaces', '{"totalSpaces":50}')).toEqual({ totalSpaces: 50 })
  })
})
