import { describe, expect, it } from 'vitest'
import { canEstimateFee, estimateFee, walkMinutes } from './parking-fee'

const p = (o: Partial<ReturnType<typeof base>> = {}) => ({ ...base(), ...o })
function base() {
  return {
    isFree: false,
    baseTime: 30,
    baseFee: 1000,
    extraTime: 15,
    extraFee: 500,
    dailyMax: undefined as number | undefined,
    monthlyPass: undefined as number | undefined,
  }
}

describe('estimateFee', () => {
  it('기본 시간 이내는 기본요금', () => {
    expect(estimateFee(p(), 30)).toBe(1000)
    expect(estimateFee(p(), 10)).toBe(1000)
  })

  it('차이나타운공영주차장 — 기본 30분 1,000원 + 15분당 500원', () => {
    // 근사식(base_fee*60/base_time)도 2,000원이라 값이 일치하는 케이스
    expect(estimateFee(p(), 60)).toBe(2000)
    expect(estimateFee(p(), 120)).toBe(4000)
  })

  it('근사식이 20% 과대평가하던 케이스 — 기본 30분 3,000원 + 15분당 1,000원', () => {
    // 근사식: 3000*60/30 = 6,000원 → 실제는 5,000원
    expect(estimateFee(p({ baseFee: 3000, extraTime: 15, extraFee: 1000 }), 60)).toBe(5000)
  })

  it('근사식이 12% 과소평가하던 케이스 — 기본 20분 2,000원 + 10분당 1,200원', () => {
    // 근사식: 2000*60/20 = 6,000원 → 실제는 6,800원
    expect(estimateFee(p({ baseTime: 20, baseFee: 2000, extraTime: 10, extraFee: 1200 }), 60)).toBe(
      6800,
    )
  })

  it('추가 단위는 올림 처리한다', () => {
    // 31분 = 기본 30분 + 1분 → 15분 단위 1회분이 붙는다
    expect(estimateFee(p(), 31)).toBe(1500)
    expect(estimateFee(p(), 45)).toBe(1500)
    expect(estimateFee(p(), 46)).toBe(2000)
  })

  it('1일 최대요금으로 상한을 건다', () => {
    const withCap = p({ dailyMax: 10000 })
    expect(estimateFee(withCap, 1440)).toBe(10000)
    expect(estimateFee(withCap, 480)).toBe(10000)
    // 상한 미만이면 그대로
    expect(estimateFee(withCap, 120)).toBe(4000)
  })

  it('무료 주차장은 0원', () => {
    // 진짜 무료 주차장은 요금표가 비어 있다
    expect(estimateFee(p({ isFree: true, baseFee: 0, extraFee: 0 }), 600)).toBe(0)
  })

  it('무료 플래그와 요금표가 동시에 있으면 0원이라 단언하지 않는다', () => {
    // remote 실측 643곳. "일부 무료 + 이후 유료" 이거나 데이터가 어긋난 경우다.
    // 0원이라고 답하면 사람이 돈을 준비하지 않고 갔다가 낭패를 본다.
    expect(estimateFee(p({ isFree: true }), 60)).toBeNull()
    expect(estimateFee(p({ isFree: true, baseFee: 0, extraFee: 500 }), 60)).toBeNull()
  })

  it('추가 요금 정보가 없으면 숫자를 지어내지 않고 null', () => {
    expect(estimateFee(p({ extraTime: 0, extraFee: 0 }), 60)).toBeNull()
    expect(estimateFee(p({ extraTime: 15, extraFee: 0 }), 60)).toBeNull()
    // 단, 기본 시간 이내라면 기본요금만으로 답할 수 있다
    expect(estimateFee(p({ extraTime: 0, extraFee: 0 }), 20)).toBe(1000)
  })

  it('기본 시간 자체가 없으면 null', () => {
    expect(estimateFee(p({ baseTime: 0 }), 60)).toBeNull()
  })

  it('최초 N분 무료(기본요금 0원) 정책도 계산한다', () => {
    // 최초 30분 무료 + 이후 15분당 500원
    expect(estimateFee(p({ baseFee: 0 }), 30)).toBe(0)
    expect(estimateFee(p({ baseFee: 0 }), 60)).toBe(1000)
  })

  it('이용시간이 0 이하면 null', () => {
    expect(estimateFee(p(), 0)).toBeNull()
  })
})

describe('canEstimateFee', () => {
  it('무료는 계산 가능 — 단 요금표가 비어 있을 때만', () => {
    expect(canEstimateFee(p({ isFree: true, baseFee: 0, extraFee: 0 }))).toBe(true)
    // 무료라면서 요금표가 있으면 어느 쪽이 맞는지 몰라 계산기를 숨긴다
    expect(canEstimateFee(p({ isFree: true }))).toBe(false)
  })
  it('추가 요금 정보가 갖춰져야 계산 가능', () => {
    expect(canEstimateFee(p())).toBe(true)
    expect(canEstimateFee(p({ extraTime: 0 }))).toBe(false)
    expect(canEstimateFee(p({ extraFee: 0 }))).toBe(false)
    expect(canEstimateFee(p({ baseTime: 0 }))).toBe(false)
  })
})

describe('walkMinutes', () => {
  it('거리를 도보 분으로 바꾼다', () => {
    expect(walkMinutes(0.099)).toBe(1)
    expect(walkMinutes(0.244)).toBe(4)
    expect(walkMinutes(1)).toBe(15)
  })
  it('아주 가까워도 최소 1분', () => {
    expect(walkMinutes(0)).toBe(1)
    expect(walkMinutes(0.01)).toBe(1)
  })

  it("문자열 'null' 이 섞여 들어와도 금액을 지어내지 않는다", () => {
    // D1 요금 컬럼 676곳에 문자열 'null' 이 들어 있다 (2026-09-03 실측).
    // 막지 않으면 baseFee + units * extraFee 가 문자열 연결이 되어 'nullNaN' 이 화면에 찍힌다.
    const poisoned = {
      isFree: false,
      baseTime: 'null',
      baseFee: 'null',
      extraTime: 'null',
      extraFee: 'null',
    } as unknown as Parameters<typeof estimateFee>[0]
    expect(estimateFee(poisoned, 60)).toBeNull()
  })
})
