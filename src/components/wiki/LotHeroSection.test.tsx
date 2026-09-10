import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { isFieldGroupEmpty } from '@/lib/lot-field-groups'
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
    // 활성 신호 없음 — final_score 는 3.0 prior 그대로다
    difficulty: { score: 3.0, reviewCount: 0, reliability: 'none' },
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
  it('시간제 유료 주차장은 1시간 예상과 1일 최대를 한 칸에 담는다', () => {
    render(<LotHeroSection lot={makeLot()} realReviewCount={0} webCount={0} />)
    const texts = kpiTexts()
    expect(texts[0]).toContain('1시간 예상')
    expect(texts[0]).toContain('2,000')
    // 요금표를 사람이 읽는 단위로
    expect(texts[0]).toContain('30분 1,000원 + 15분 500원')
    // 1일 최대는 독립된 칸이 아니라 요금 칸의 캡션이다
    expect(texts[0]).toContain('1일 최대 10,000원')
    expect(texts[1]).not.toContain('1일 최대')
  })

  it('두 번째 칸은 1일 최대가 아니라 운영 시간이다', () => {
    render(<LotHeroSection lot={makeLot()} realReviewCount={0} webCount={0} />)
    const texts = kpiTexts()
    expect(texts[1]).toContain('평일 운영')
    expect(texts[1]).toContain('09:00-21:00')
    // 세 요일이 같으면 캡션에 시각을 두 번 더 늘어놓지 않는다
    expect(texts[1]).toContain('토·공휴일 동일')
  })

  it('평일과 다른 요일만 캡션에 적는다', () => {
    render(
      <LotHeroSection
        lot={makeLot({
          operatingHours: {
            weekday: { start: '09:00', end: '21:00' },
            saturday: { start: '10:00', end: '18:00' },
            holiday: { start: '09:00', end: '21:00' },
          },
        })}
        realReviewCount={0}
        webCount={0}
      />,
    )
    const hours = kpiTexts().find((t) => t.includes('평일 운영')) ?? ''
    expect(hours).toContain('토 10:00-18:00')
    expect(hours).not.toContain('공휴일')
  })

  it('평일만 다르고 토·공휴일이 같으면 시각을 한 번만 적는다', () => {
    render(
      <LotHeroSection
        lot={makeLot({
          operatingHours: {
            weekday: { start: '09:00', end: '18:00' },
            saturday: { start: '00:00', end: '24:00' },
            holiday: { start: '00:00', end: '23:59' },
          },
        })}
        realReviewCount={0}
        webCount={0}
      />,
    )
    // 끝 시각 인코딩이 달라도 둘 다 24시간이라 같은 문장이 된다
    expect(kpiTexts()[1]).toContain('토·공휴일 24시간')
  })

  it('24시간 운영은 00:00-24:00 이 아니라 「24시간」으로 적는다', () => {
    // MODU·하이파킹이 주는 인코딩. 미상으로 보던 시절엔 「정보 없음」이 나왔다 (9,835곳)
    render(
      <LotHeroSection
        lot={makeLot({
          operatingHours: {
            weekday: { start: '00:00', end: '24:00' },
            saturday: { start: '00:00', end: '24:00' },
            holiday: { start: '00:00', end: '24:00' },
          },
        })}
        realReviewCount={0}
        webCount={0}
      />,
    )
    const hours = kpiTexts()[1]
    expect(hours).toContain('24시간')
    expect(hours).not.toContain('24:00')
    expect(hours).not.toContain('정보 없음')
  })

  it('운영시간을 모르면 칸을 지우지 않고 「정보 없음」으로 남긴다', () => {
    render(
      <LotHeroSection
        lot={makeLot({
          operatingHours: {
            weekday: { start: 'null', end: 'null' },
            saturday: { start: '', end: '' },
            holiday: { start: '00:00', end: '00:00' },
          },
        })}
        realReviewCount={0}
        webCount={0}
      />,
    )
    const hours = kpiTexts()[1]
    expect(hours).toContain('운영 시간')
    expect(hours).toContain('정보 없음')
    // 크롤러가 써 넣은 문자열 'null' 이 화면에 나오면 안 된다
    expect(hours).not.toContain('null')
  })

  it('요금표는 없고 1일 최대만 아는 곳은 그 값을 요금 칸에 세운다', () => {
    render(
      <LotHeroSection
        lot={makeLot({
          pricing: {
            isFree: false,
            baseTime: 0,
            baseFee: 0,
            extraTime: 0,
            extraFee: 0,
            dailyMax: 20000,
          },
        })}
        realReviewCount={0}
        webCount={0}
      />,
    )
    const fee = kpiTexts()[0]
    // 값 자리에 아는 금액이 서고, 모르는 건 캡션에서만 말한다
    expect(fee).toBe('1일 최대20,000원시간당 요금 정보 없음')
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
        webCount={0}
      />,
    )
    const texts = kpiTexts()
    expect(texts[0]).toContain('종일 정액')
    expect(texts[0]).not.toContain('1시간 예상')
    // 1440분이 아니라 24시간으로 읽힌다
    expect(texts[0]).toContain('24시간')
    // 같은 금액을 두 번 쓰지 않는다 — 정액제에선 1일 최대를 캡션에 되풀이하지 않는다
    expect(texts[0]).not.toContain('1일 최대')
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
        webCount={0}
      />,
    )
    const texts = kpiTexts()
    const fee = texts.find((t) => t.includes('주차 요금')) ?? ''
    expect(fee).toContain('정보 없음')
  })

  it('신호가 있으면 통합 「쉬움 점수」를 쓰고 어디서 나온 값인지 밝힌다', () => {
    const { container } = render(
      <LotHeroSection
        lot={makeLot({ difficulty: { score: 2.6, reviewCount: 2, reliability: 'estimated' } })}
        realReviewCount={2}
        webCount={30}
      />,
    )
    const score = kpiTexts().find((t) => t.includes('쉬움 점수')) ?? ''
    expect(score).toContain('2.6')
    expect(score).toContain('이용자 2명')
    expect(score).toContain('참고한 글 30건')
    // 웹 감성이 섞인 AI 추정값이다 — 별점처럼 보이면 안 된다
    expect(score).not.toContain('/5')
    expect(container.querySelectorAll('.fill-yellow-400')).toHaveLength(0)
  })

  it('이용자 후기 없이 웹 글만으로 점수가 섰으면 그렇게 말한다', () => {
    render(
      <LotHeroSection
        lot={makeLot({ difficulty: { score: 3.6, reviewCount: 0, reliability: 'confirmed' } })}
        realReviewCount={0}
        webCount={51}
      />,
    )
    const score = kpiTexts().find((t) => t.includes('쉬움 점수')) ?? ''
    expect(score).toContain('3.6')
    expect(score).toContain('참고한 글 51건')
    expect(score).not.toContain('이용자')
  })

  it('신호가 없으면 3.0 prior 를 점수처럼 내보내지 않는다', () => {
    // difficulty.score 는 3.0 이지만 기본정보만으로 만든 사전값이다.
    // 한때 이 값을 이용자 별점으로 내보내서 이용자 2명이 0.5를 준 곳이 2.3으로 나갔다.
    render(<LotHeroSection lot={makeLot()} realReviewCount={0} webCount={0} />)
    const score = kpiTexts().find((t) => t.includes('쉬움 점수')) ?? ''
    expect(score).toContain('—')
    expect(score).not.toContain('3.0')
  })

  it('약한 신호(reference)만 있어도 prior 를 내보내지 않는다', () => {
    render(
      <LotHeroSection
        lot={makeLot({ difficulty: { score: 3.0, reviewCount: 0, reliability: 'reference' } })}
        realReviewCount={0}
        webCount={3}
      />,
    )
    const score = kpiTexts().find((t) => t.includes('쉬움 점수')) ?? ''
    expect(score).toContain('—')
    expect(score).not.toContain('3.0')
  })

  it('무료 회차·할인 조건이 있으면 지표 위에 그대로 보여준다', () => {
    render(
      <LotHeroSection
        lot={makeLot({ notes: 'CGV 이용 시 최대 5시간 무료 주차 혜택 제공' })}
        realReviewCount={0}
        webCount={0}
      />,
    )
    expect(screen.getByText('CGV 이용 시 최대 5시간 무료 주차 혜택 제공')).toBeTruthy()
  })

  it('주차면 수를 모르면 칸을 지우지 않고 「정보 없음」으로 남긴다', () => {
    // 칸을 빼면 우리가 모르는 건지 그런 항목이 없는 건지 구분되지 않는다
    render(<LotHeroSection lot={makeLot({ totalSpaces: 0 })} realReviewCount={0} webCount={0} />)
    const spaces = kpiTexts().find((t) => t.includes('주차면')) ?? ''
    expect(spaces).toContain('정보 없음')
  })

  // 빈 칸을 눌러 제보하는 흐름의 전제 — 「정보 없음」 판정과 서버의 「비어 있음」 판정이
  // 어긋나면 유저가 빈 칸을 채웠는데 "관리자 확인 후 반영" 이 뜬다
  it('「정보 없음」으로 그리는 칸은 서버도 비어 있다고 본다', () => {
    const empty = makeLot({
      totalSpaces: 0,
      pricing: { isFree: false, baseTime: 0, baseFee: 0, extraTime: 0, extraFee: 0 },
      operatingHours: {
        weekday: { start: '', end: '' },
        saturday: { start: '', end: '' },
        holiday: { start: '', end: '' },
      },
    })
    render(<LotHeroSection lot={empty} realReviewCount={0} webCount={0} />)
    const texts = kpiTexts()
    expect(texts[0]).toContain('정보 없음')
    expect(texts[1]).toContain('정보 없음')
    expect(texts[2]).toContain('정보 없음')
    for (const group of ['fee', 'hours', 'spaces'] as const) {
      expect(isFieldGroupEmpty(empty, group)).toBe(true)
    }
  })

  it('빈 칸은 눌러서 채울 수 있는 버튼이다', () => {
    render(<LotHeroSection lot={makeLot({ totalSpaces: 0 })} realReviewCount={0} webCount={0} />)
    const spaces = kpiTexts().find((t) => t.includes('주차면')) ?? ''
    expect(spaces).toContain('정보 추가')
    // 값이 있는 칸에는 붙지 않는다
    expect(kpiTexts()[0]).not.toContain('정보 추가')
  })

  // 예전엔 값이 있는 칸으로 가는 길이 「수정 제안」 링크 하나였고 그게 요금 폼만 열었다.
  // 운영시간·면수가 틀린 경우엔 고칠 방법이 아예 없었다.
  it('값이 있는 칸도 눌러서 수정 제안할 수 있다', () => {
    const { container } = render(
      <LotHeroSection lot={makeLot()} realReviewCount={0} webCount={0} />,
    )
    const cells = [...(container.querySelector('[data-testid="kpi-grid"] > div')?.children ?? [])]
    // 요금·운영시간·주차면 세 칸은 버튼, 쉬움 점수는 아니다
    expect(cells.slice(0, 3).every((c) => c.querySelector('button'))).toBe(true)
    expect(cells[3].querySelector('button')).toBeNull()
  })

  it('유저 제보로 선 값에는 「유저제보」 배지가 붙는다', () => {
    render(
      <LotHeroSection
        lot={makeLot()}
        realReviewCount={0}
        webCount={0}
        fieldSources={{ fee: 'user', hours: 'official', spaces: 'verified' }}
      />,
    )
    const texts = kpiTexts()
    expect(texts[0]).toContain('유저제보')
    // 관리자가 확인한 값은 원본과 같은 무게로 그린다 — 배지 없음
    expect(texts[2]).not.toContain('유저제보')
    expect(texts[1]).not.toContain('유저제보')
  })

  it('주소와 이름은 항상 나온다', () => {
    render(<LotHeroSection lot={makeLot()} realReviewCount={0} webCount={0} />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('테스트 주차장')
    expect(screen.getByText('서울시 어딘가')).toBeTruthy()
  })
})
