import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ParkingLot } from '@/types/parking'
import { LotHeroSection } from './LotHeroSection'

function makeLot(over: Partial<ParkingLot> = {}): ParkingLot {
  return {
    id: 'KA-1',
    name: '테스트 주차장',
    type: '노외',
    address: '서울시 어딘가',
    lat: 37.5,
    lng: 127,
    totalSpaces: 186,
    phone: null,
    pricing: {
      isFree: false,
      baseTime: 30,
      baseFee: 1000,
      extraTime: 15,
      extraFee: 500,
      dailyMax: 10000,
    },
    difficulty: { score: 3.0, reliability: 'low' },
    operatingHours: {
      weekday: { start: '09:00', end: '21:00' },
      saturday: { start: '09:00', end: '21:00' },
      holiday: { start: '09:00', end: '21:00' },
    },
    ...over,
  } as ParkingLot
}

function kpiTexts(): string[] {
  // DividerGrid 는 바깥쪽 한 겹(overflow-hidden) 안에 실제 그리드를 둔다
  const grid = document.querySelector('[data-testid="kpi-grid"] > div')
  return grid ? [...grid.children].map((c) => (c as HTMLElement).textContent ?? '') : []
}

describe('LotHeroSection KPI', () => {
  it('시간제 유료 주차장은 1시간 예상과 1일 최대를 함께 보여준다', () => {
    render(<LotHeroSection lot={makeLot()} realReviewCount={0} realReviewScore={null} />)
    const texts = kpiTexts()
    expect(texts[0]).toContain('1시간 예상')
    expect(texts[0]).toContain('2,000')
    // 요금표를 사람이 읽는 단위로
    expect(texts[0]).toContain('30분 1,000원 + 15분 500원')
    expect(texts[1]).toContain('1일 최대')
  })

  it('기본시간이 하루 이상이면 「1시간 예상」이 아니라 「종일 정액」이다', () => {
    render(
      <LotHeroSection
        lot={makeLot({
          pricing: {
            isFree: false,
            baseTime: 1440,
            baseFee: 2000,
            extraTime: 0,
            extraFee: 0,
            dailyMax: 2000,
          },
        })}
        realReviewCount={0}
        realReviewScore={null}
      />,
    )
    const texts = kpiTexts()
    expect(texts[0]).toContain('종일 정액')
    expect(texts[0]).not.toContain('1시간 예상')
    // 1440분이 아니라 24시간으로 읽힌다
    expect(texts[0]).toContain('24시간')
    // 같은 금액을 두 번 쓰지 않는다 — 칸은 남기되 「동일」로 표시한다
    const daily = texts.find((t) => t.includes('1일 최대')) ?? ''
    expect(daily).toContain('동일')
    expect(daily).not.toContain('2,000')
  })

  it('요금표가 모자란 유료 주차장은 요금 칸을 아예 그리지 않는다', () => {
    render(
      <LotHeroSection
        lot={makeLot({
          pricing: {
            isFree: false,
            baseTime: 0,
            baseFee: 0,
            extraTime: 0,
            extraFee: 0,
          },
        })}
        realReviewCount={0}
        realReviewScore={null}
      />,
    )
    const texts = kpiTexts()
    const fee = texts.find((t) => t.includes('주차 요금')) ?? ''
    expect(fee).toContain('정보 없음')
  })

  it('실사용자 후기가 있으면 그 별점을 쓰고 근거를 밝힌다', () => {
    render(<LotHeroSection lot={makeLot()} realReviewCount={24} realReviewScore={4.2} />)
    const score = kpiTexts().find((t) => t.includes('이용자 별점')) ?? ''
    expect(score).toContain('4.2')
    expect(score).toContain('이용자 24명')
  })

  it('후기가 없으면 숫자를 지어내지 않는다 — 구조 추정값을 이 자리에 쓰지 않는다', () => {
    // difficulty.score 는 3.0 이지만 사람이 매긴 값이 아니다.
    // 한때 이 값을 이용자 별점으로 내보내서 이용자 2명이 0.5를 준 곳이 2.3으로 나갔다.
    render(<LotHeroSection lot={makeLot()} realReviewCount={0} realReviewScore={null} />)
    const score = kpiTexts().find((t) => t.includes('이용자 별점')) ?? ''
    expect(score).toContain('—')
    expect(score).not.toContain('3.0')
  })

  it('무료 회차·할인 조건이 있으면 지표 위에 그대로 보여준다', () => {
    render(
      <LotHeroSection
        lot={makeLot({ notes: 'CGV 이용 시 최대 5시간 무료 주차 혜택 제공' })}
        realReviewCount={0}
        realReviewScore={null}
      />,
    )
    expect(screen.getByText('CGV 이용 시 최대 5시간 무료 주차 혜택 제공')).toBeTruthy()
  })

  it('주차면 수를 모르면 칸을 지우지 않고 「정보 없음」으로 남긴다', () => {
    // 칸을 빼면 우리가 모르는 건지 그런 항목이 없는 건지 구분되지 않는다
    render(
      <LotHeroSection
        lot={makeLot({ totalSpaces: 0 })}
        realReviewCount={0}
        realReviewScore={null}
      />,
    )
    const spaces = kpiTexts().find((t) => t.includes('주차면')) ?? ''
    expect(spaces).toContain('정보 없음')
  })

  it('주소와 이름은 항상 나온다', () => {
    render(<LotHeroSection lot={makeLot()} realReviewCount={0} realReviewScore={null} />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('테스트 주차장')
    expect(screen.getByText('서울시 어딘가')).toBeTruthy()
  })
})
