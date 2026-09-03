import { describe, expect, it } from 'vitest'
import { type CandidateLot, dedupeTwins, distanceMeters, evaluateGate, hasUsableData } from './gate'

// 석촌역 (공공데이터 좌표 근사)
const SEOKCHON = { name: '석촌역', lat: 37.5054, lng: 127.1067 }

function lot(overrides: Partial<CandidateLot> & { id: string }): CandidateLot {
  return {
    name: overrides.id,
    lat: SEOKCHON.lat + 0.002, // 약 220m 북쪽
    lng: SEOKCHON.lng,
    totalSpaces: 40,
    isFree: false,
    baseFee: 250,
    evidenceSourceId: null,
    ...overrides,
  }
}

describe('distanceMeters', () => {
  it('위도 0.009도는 약 1km 다', () => {
    const d = distanceMeters(37.5, 127.1, 37.509, 127.1)
    expect(d).toBeGreaterThan(990)
    expect(d).toBeLessThan(1010)
  })
})

describe('hasUsableData', () => {
  it('무료 플래그, 기본요금, 면수 중 하나라도 있으면 참', () => {
    expect(hasUsableData(lot({ id: 'a', isFree: true, baseFee: null, totalSpaces: 0 }))).toBe(true)
    expect(hasUsableData(lot({ id: 'b', isFree: false, baseFee: 500, totalSpaces: 0 }))).toBe(true)
    expect(hasUsableData(lot({ id: 'c', isFree: false, baseFee: null, totalSpaces: 12 }))).toBe(
      true,
    )
  })
  it('셋 다 없으면 거짓 — 비교표에 빈 줄이 될 주차장', () => {
    expect(hasUsableData(lot({ id: 'd', isFree: false, baseFee: null, totalSpaces: 0 }))).toBe(
      false,
    )
    expect(hasUsableData(lot({ id: 'e', isFree: false, baseFee: 0, totalSpaces: 0 }))).toBe(false)
  })
})

describe('dedupeTwins', () => {
  it('좌표·면수가 같은 KA-/공공데이터 쌍은 공공데이터만 남긴다', () => {
    const ka = lot({ id: 'KA-365568988', lat: 37.50541, lng: 127.10672 })
    const pub = lot({ id: '123-1-000008', lat: 37.50543, lng: 127.10669 })
    const { kept, twins } = dedupeTwins([ka, pub])
    expect(kept.map((l) => l.id)).toEqual(['123-1-000008'])
    expect(twins).toEqual([['123-1-000008', 'KA-365568988']])
  })
  it('좌표가 12m 어긋나도 면수가 같으면 같은 주차장이다', () => {
    const ka = lot({ id: 'KA-1', name: '송파근린공원주차장', totalSpaces: 324 })
    const nv = lot({
      id: 'NV-2',
      name: '송파근린공원 공영주차장',
      totalSpaces: 324,
      lat: SEOKCHON.lat + 0.0021,
    })
    expect(dedupeTwins([ka, nv]).kept).toHaveLength(1)
  })
  it('면수를 모르는 0면끼리는 묶지 않는다', () => {
    const a = lot({ id: 'KA-1', totalSpaces: 0 })
    const b = lot({ id: 'KA-2', totalSpaces: 0 })
    expect(dedupeTwins([a, b]).kept).toHaveLength(2)
  })
  it('면수가 다르면 다른 주차장으로 본다', () => {
    const a = lot({ id: 'KA-1', totalSpaces: 40 })
    const b = lot({ id: '123-1-000001', totalSpaces: 85 })
    expect(dedupeTwins([a, b]).kept).toHaveLength(2)
  })
})

describe('evaluateGate', () => {
  const three = [
    lot({ id: '1', evidenceSourceId: 101 }),
    lot({ id: '2', lat: SEOKCHON.lat + 0.004 }),
    lot({ id: '3', lat: SEOKCHON.lat - 0.003, isFree: true, baseFee: null }),
  ]

  it('좌표가 없으면 no_coords', () => {
    const r = evaluateGate({ name: 'x', lat: null, lng: null }, three)
    expect(r.pass).toBe(false)
    if (!r.pass) expect(r.reason).toBe('no_coords')
  })

  it('반경 밖 주차장은 세지 않는다 → too_few_lots', () => {
    const far = three.map((l) => ({ ...l, lat: SEOKCHON.lat + 0.02 })) // 약 2.2km
    const r = evaluateGate(SEOKCHON, far)
    expect(r.pass).toBe(false)
    if (!r.pass) expect(r.reason).toBe('too_few_lots')
  })

  it('요금·면수를 아는 곳이 2곳 미만이면 too_few_lots_with_data', () => {
    const blank = three.map((l) => ({ ...l, isFree: false, baseFee: null, totalSpaces: 0 }))
    const r = evaluateGate(SEOKCHON, blank)
    expect(r.pass).toBe(false)
    if (!r.pass) expect(r.reason).toBe('too_few_lots_with_data')
  })

  it('목적지를 언급한 web_source 연결이 없으면 no_evidence', () => {
    const noEv = three.map((l) => ({ ...l, evidenceSourceId: null }))
    const r = evaluateGate(SEOKCHON, noEv)
    expect(r.pass).toBe(false)
    if (!r.pass) expect(r.reason).toBe('no_evidence')
  })

  it('통과하면 가까운 순으로 rank 를 매기고 무료 수를 센다', () => {
    const r = evaluateGate(SEOKCHON, three)
    expect(r.pass).toBe(true)
    if (r.pass) {
      expect(r.lots.map((l) => l.id)).toEqual(['1', '3', '2'])
      expect(r.lots[0].rank).toBe(1)
      expect(r.lots[0].distanceM).toBeGreaterThan(200)
      expect(r.freeCount).toBe(1)
    }
  })

  it('bbox 로 넉넉히 넘겨도 반경 안만 결과에 남는다', () => {
    const r = evaluateGate(SEOKCHON, [...three, lot({ id: 'far', lat: SEOKCHON.lat + 0.03 })])
    expect(r.pass).toBe(true)
    if (r.pass) expect(r.lots.map((l) => l.id)).not.toContain('far')
  })
})
