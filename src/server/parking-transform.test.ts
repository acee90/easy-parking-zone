import { describe, expect, it } from 'vitest'
import { buildFilterClauses, type ParkingLotRow, rowToParkingLot } from './transforms'

// ============================================================
// rowToParkingLot — DB row → ParkingLot 변환 (Drizzle 전환 후 동일 출력 보장)
// ============================================================

function makeRow(overrides: Partial<ParkingLotRow> = {}): ParkingLotRow {
  return {
    id: 'PK-001',
    name: '서울역 주차장',
    type: '노외',
    address: '서울시 용산구 한강대로 405',
    lat: 37.5547,
    lng: 126.9706,
    total_spaces: 500,
    free_spaces: null,
    weekday_start: '00:00',
    weekday_end: '23:59',
    saturday_start: '00:00',
    saturday_end: '23:59',
    holiday_start: '00:00',
    holiday_end: '23:59',
    is_free: 0,
    base_time: 30,
    base_fee: 1000,
    extra_time: 15,
    extra_fee: 500,
    daily_max: 20000,
    monthly_pass: 150000,
    phone: '02-1234-5678',
    payment_methods: '카드,현금',
    notes: null,
    curation_tag: null,
    curation_reason: null,
    featured_source: null,
    poi_tags: null,
    avg_score: 3.5,
    review_count: 10,
    reliability: 'medium',
    ...overrides,
  }
}

describe('rowToParkingLot', () => {
  it('기본 필드를 올바르게 변환', () => {
    const result = rowToParkingLot(makeRow())

    expect(result.id).toBe('PK-001')
    expect(result.name).toBe('서울역 주차장')
    expect(result.type).toBe('노외')
    expect(result.address).toBe('서울시 용산구 한강대로 405')
    expect(result.lat).toBe(37.5547)
    expect(result.lng).toBe(126.9706)
    expect(result.totalSpaces).toBe(500)
  })

  it('운영시간을 중첩 객체로 변환', () => {
    const result = rowToParkingLot(makeRow())
    expect(result.operatingHours).toEqual({
      weekday: { start: '00:00', end: '23:59' },
      saturday: { start: '00:00', end: '23:59' },
      holiday: { start: '00:00', end: '23:59' },
    })
  })

  it('요금 정보를 올바르게 변환', () => {
    const result = rowToParkingLot(makeRow())
    expect(result.pricing).toEqual({
      isFree: false,
      baseTime: 30,
      baseFee: 1000,
      extraTime: 15,
      extraFee: 500,
      dailyMax: 20000,
      monthlyPass: 150000,
    })
  })

  it('무료 주차장 (is_free=1)', () => {
    const result = rowToParkingLot(makeRow({ is_free: 1 }))
    expect(result.pricing.isFree).toBe(true)
  })

  it('난이도 정보를 올바르게 변환', () => {
    const result = rowToParkingLot(makeRow())
    expect(result.difficulty).toEqual({
      score: 3.5,
      reviewCount: 10,
      reliability: 'medium',
    })
  })

  it('avg_score null이면 score null', () => {
    const result = rowToParkingLot(makeRow({ avg_score: null }))
    expect(result.difficulty.score).toBeNull()
  })

  it('reliability null이면 undefined', () => {
    const result = rowToParkingLot(makeRow({ reliability: null }))
    expect(result.difficulty.reliability).toBeUndefined()
  })

  it('null 필드를 undefined로 변환', () => {
    const result = rowToParkingLot(
      makeRow({
        free_spaces: null,
        phone: null,
        payment_methods: null,
        notes: null,
        daily_max: null,
        monthly_pass: null,
      }),
    )
    expect(result.freeSpaces).toBeUndefined()
    expect(result.phone).toBeUndefined()
    expect(result.paymentMethods).toBeUndefined()
    expect(result.notes).toBeUndefined()
    expect(result.pricing.dailyMax).toBeUndefined()
    expect(result.pricing.monthlyPass).toBeUndefined()
  })

  it('base_time/base_fee null이면 0', () => {
    const result = rowToParkingLot(
      makeRow({ base_time: null, base_fee: null, extra_time: null, extra_fee: null }),
    )
    expect(result.pricing.baseTime).toBe(0)
    expect(result.pricing.baseFee).toBe(0)
    expect(result.pricing.extraTime).toBe(0)
    expect(result.pricing.extraFee).toBe(0)
  })

  it('poi_tags JSON 파싱', () => {
    const result = rowToParkingLot(makeRow({ poi_tags: '["서울역","용산역"]' }))
    expect(result.poiTags).toEqual(['서울역', '용산역'])
  })

  it('poi_tags null이면 undefined', () => {
    const result = rowToParkingLot(makeRow({ poi_tags: null }))
    expect(result.poiTags).toBeUndefined()
  })

  it('curation_tag 전달', () => {
    const result = rowToParkingLot(
      makeRow({
        curation_tag: 'hell',
        curation_reason: '좁은 골목 진입로',
        featured_source: 'https://youtube.com/watch?v=xxx',
      }),
    )
    expect(result.curationTag).toBe('hell')
    expect(result.curationReason).toBe('좁은 골목 진입로')
    expect(result.featuredSource).toBe('https://youtube.com/watch?v=xxx')
  })

  it('freeSpaces가 있으면 숫자 전달', () => {
    const result = rowToParkingLot(makeRow({ free_spaces: 42 }))
    expect(result.freeSpaces).toBe(42)
  })
})

// ============================================================
// buildFilterClauses
// ============================================================

describe('buildFilterClauses', () => {
  it('필터 없으면 빈 where', () => {
    const { where, params } = buildFilterClauses()
    expect(where).toBe('')
    expect(params).toEqual([])
  })

  it('freeOnly 필터', () => {
    const { where } = buildFilterClauses({ freeOnly: true } as any)
    expect(where).toContain('p.is_free = 1')
  })

  it('publicOnly 필터 (KA-/NV- 제외)', () => {
    const { where } = buildFilterClauses({ publicOnly: true } as any)
    expect(where).toContain("NOT LIKE 'KA-%'")
    expect(where).toContain("NOT LIKE 'NV-%'")
  })

  it('excludeNoSang 필터', () => {
    const { where } = buildFilterClauses({ excludeNoSang: true } as any)
    expect(where).toContain("p.type != '노상'")
  })

  it('복합 필터는 AND로 결합', () => {
    const { where } = buildFilterClauses({
      freeOnly: true,
      publicOnly: true,
      excludeNoSang: true,
    } as any)
    expect(where).toContain('AND')
    expect(where).toContain('p.is_free = 1')
    expect(where).toContain("NOT LIKE 'KA-%'")
    expect(where).toContain("p.type != '노상'")
  })
})
