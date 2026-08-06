import { describe, expect, it } from 'vitest'
import { getDistance } from './geo-utils'
import {
  buildProbeGrid,
  MAX_JUMP_M,
  NEAR_ENOUGH_M,
  type PanoCandidate,
  selectPanorama,
} from './roadview-select'

const LOT = { lat: 37.6265483, lng: 127.0618877 }

/** 주차장에서 정북으로 distanceM 떨어진 후보 (위도 1도 ≈ 111,320m) */
function candidateAt(panoId: string, distanceM: number, photodate?: string): PanoCandidate {
  return { panoId, lat: LOT.lat + distanceM / 111_320, lng: LOT.lng, photodate }
}

describe('buildProbeGrid', () => {
  it('반경 3 × 방위 6 = 18개 좌표를 만든다', () => {
    expect(buildProbeGrid(LOT.lat, LOT.lng)).toHaveLength(18)
  })

  it('원점은 포함하지 않는다 — 표시용 인스턴스가 이미 조회한 지점이다', () => {
    for (const point of buildProbeGrid(LOT.lat, LOT.lng)) {
      expect(getDistance(LOT.lat, LOT.lng, point.lat, point.lng) * 1000).toBeGreaterThan(1)
    }
  })

  it('요청한 반경대로 떨어진 좌표를 만든다', () => {
    const distances = buildProbeGrid(LOT.lat, LOT.lng).map((p) =>
      Math.round(getDistance(LOT.lat, LOT.lng, p.lat, p.lng) * 1000),
    )
    expect(new Set(distances)).toEqual(new Set([30, 60, 100]))
  })
})

describe('selectPanorama', () => {
  it('후보가 없으면 null', () => {
    expect(selectPanorama([], LOT.lat, LOT.lng)).toBeNull()
  })

  // 대다수 주차장이 이 경로다. 최근접이 이미 주차장 앞이면 건드리지 않는다.
  it('최근접이 가드 안이면 촬영일이 더 오래됐어도 최근접을 쓴다', () => {
    const selection = selectPanorama(
      [candidateAt('near', 2.4, '2026-01-16'), candidateAt('far', 109, '2026-01-21')],
      LOT.lat,
      LOT.lng,
    )
    expect(selection?.chosen.panoId).toBe('near')
    expect(selection?.reason).toBe('near-enough')
  })

  // 미사경정공원 P1: 43.6m 최근접이 주차 구획을 정면으로 비추는데 규칙은 73.8m 외곽 도로를
  // 골랐다. 점프가 +30m라 상한에 안 걸려서, 가드를 50m로 올려 막는다.
  it('30~50m 구간에서는 규칙이 개입하지 않는다', () => {
    const selection = selectPanorama(
      [
        candidateAt('lot-inside', 43.6, '2024-05-01'),
        candidateAt('outer-road', 73.8, '2025-09-04'),
      ],
      LOT.lat,
      LOT.lng,
    )
    expect(selection?.chosen.panoId).toBe('lot-inside')
    expect(selection?.reason).toBe('near-enough')
  })

  // 이마트 월계점: 56m 뒷골목(2025-01) 대신 86m 정문(2026-02)을 골라야 한다.
  it('최근접이 멀면 촬영일 최신 그룹에서 가장 가까운 후보를 고른다', () => {
    const selection = selectPanorama(
      [
        candidateAt('back-alley', 56.2, '2025-01-22'),
        candidateAt('front-gate', 86, '2026-02-23'),
        candidateAt('front-far', 96, '2026-02-23'),
      ],
      LOT.lat,
      LOT.lng,
    )
    expect(selection?.chosen.panoId).toBe('front-gate')
    expect(selection?.reason).toBe('latest-date')
    expect(selection?.nearest.panoId).toBe('back-alley')
    expect(selection?.candidateCount).toBe(3)
  })

  // 가드를 넘긴 뒤에도 멀리 튀는 것은 막는다 (롯데백화점일원 35m → 101m 패턴의 원거리판).
  it('최신 후보가 최근접보다 60m 넘게 멀면 최근접으로 되돌린다', () => {
    const selection = selectPanorama(
      [candidateAt('gate', 60, '2025-05-01'), candidateAt('overpass', 130, '2026-04-01')],
      LOT.lat,
      LOT.lng,
    )
    expect(selection?.chosen.panoId).toBe('gate')
    expect(selection?.reason).toBe('jump-capped')
  })

  it('점프가 상한과 같으면 채택한다', () => {
    const selection = selectPanorama(
      [
        candidateAt('nearest', NEAR_ENOUGH_M + 10, '2025-05-01'),
        candidateAt('latest', NEAR_ENOUGH_M + 10 + MAX_JUMP_M, '2026-04-01'),
      ],
      LOT.lat,
      LOT.lng,
    )
    expect(selection?.chosen.panoId).toBe('latest')
    expect(selection?.reason).toBe('latest-date')
  })

  // 같은 날 더 늦게 찍힌 다른 도로가 뽑히면 전혀 다른 건물이 나온다.
  it('시각이 아니라 날짜 단위로 그룹핑한다', () => {
    const selection = selectPanorama(
      [
        candidateAt('same-day-early', 55, '2026-02-23 09:10:00'),
        candidateAt('same-day-late', 85, '2026-02-23 14:15:00'),
      ],
      LOT.lat,
      LOT.lng,
    )
    expect(selection?.chosen.panoId).toBe('same-day-early')
    expect(selection?.reason).toBe('nearest-is-latest')
  })

  it('촬영일이 없으면 최근접을 쓴다', () => {
    const selection = selectPanorama([candidateAt('a', 55), candidateAt('b', 85)], LOT.lat, LOT.lng)
    expect(selection?.chosen.panoId).toBe('a')
    expect(selection?.reason).toBe('nearest-is-latest')
  })
})
