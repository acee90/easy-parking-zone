import { getDistance } from '@/lib/geo-utils'

/**
 * 로드뷰 파노라마 선택 규칙.
 *
 * 네이버 Panorama는 주어진 좌표에서 "가장 가까운" 파노라마를 고르는데, 주차장 좌표가 부지
 * 중심점이면 건물 뒤 이면도로가 잡혀 엉뚱한 벽만 나온다. 주변을 프로브해 후보를 모은 뒤
 * 촬영일이 최신인 쪽(= 간선도로·건물 정면일 확률이 높은 쪽)을 고르는 것이 이 모듈의 역할이다.
 *
 * 상수와 규칙은 73곳 실측으로 검증했다. docs/exec-plans/roadview-quality-fix.plan.md 참고.
 *
 * 결과는 절대 저장하지 않는다 — 네이버 약관상 호출 데이터의 DB 저장이 금지돼 있어,
 * 페이지가 열려 있는 동안 메모리에만 두고 쓴다.
 */

/**
 * 최근접 파노라마가 이 거리 안이면 이미 주차장 바로 앞이라고 보고 규칙을 적용하지 않는다.
 *
 * 가드가 없으면 최근접이 2.4m인 노상주차장에서 "5일 더 최신"이라는 이유로 109m 떨어진
 * 다른 건물 앞을 고르는 개악이 발생했다.
 *
 * 처음에는 30m였다. 육안 검수에서 **개선이 확인된 사례는 최근접이 56.2m·67.8m**뿐이고,
 * 30~50m 구간에는 개선 사례가 없다 — 개악(35.4m·34.7m·43.6m)과 미검수만 있었다.
 * 43.6m인 미사경정공원 P1은 최근접이 주차 구획을 정면으로 비추는데도 규칙이 73.8m 외곽
 * 도로를 골랐고(점프 +30m라 상한에도 안 걸린다), 이 사각지대를 없애려고 50m로 올렸다.
 */
export const NEAR_ENOUGH_M = 50

/**
 * 규칙이 고른 후보가 최근접보다 이만큼 넘게 멀면 채택하지 않는다.
 *
 * 정상 개선 케이스의 점프는 +0.8~+43m였고, 개악 2건은 모두 +66m 이상이었다.
 */
export const MAX_JUMP_M = 60

/** 프로브 격자. 원점(r=0)은 표시용 인스턴스가 이미 조회했으므로 뺀다 → 3 × 6 = 18회. */
export const PROBE_RADII_M = [30, 60, 100]
export const PROBE_BEARINGS_DEG = [0, 60, 120, 180, 240, 300]

const EARTH_RADIUS_M = 6_371_000

export interface PanoCandidate {
  panoId: string
  lat: number
  lng: number
  /** 촬영일시. 'YYYY-MM-DD ...' 형태이며 없을 수 있다. */
  photodate?: string
}

export interface ScoredCandidate extends PanoCandidate {
  /** 주차장으로부터의 거리(m) */
  distanceM: number
}

export type SelectionReason =
  /** 최근접이 이미 주차장 앞이라 규칙을 적용하지 않음 */
  | 'near-enough'
  /** 규칙을 적용했지만 결과가 최근접과 같음 */
  | 'nearest-is-latest'
  /** 촬영일 최신 그룹에서 다른 후보를 채택 */
  | 'latest-date'
  /** 최신 후보가 너무 멀어 최근접으로 되돌림 */
  | 'jump-capped'

export interface RoadviewSelection {
  chosen: ScoredCandidate
  nearest: ScoredCandidate
  reason: SelectionReason
  candidateCount: number
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180
}

function toDeg(rad: number) {
  return (rad * 180) / Math.PI
}

/** 기준점에서 방위각 `bearingDeg`로 `distanceM`만큼 떨어진 좌표 */
function offsetCoord(lat: number, lng: number, bearingDeg: number, distanceM: number) {
  const angular = distanceM / EARTH_RADIUS_M
  const bearing = toRad(bearingDeg)
  const lat1 = toRad(lat)
  const lng1 = toRad(lng)
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing),
  )
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    )
  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 }
}

/** 주차장 주변 프로브 좌표 목록 (반경 × 방위) */
export function buildProbeGrid(lat: number, lng: number): Array<{ lat: number; lng: number }> {
  return PROBE_RADII_M.flatMap((radius) =>
    PROBE_BEARINGS_DEG.map((bearing) => offsetCoord(lat, lng, bearing, radius)),
  )
}

/** 촬영 '날짜'까지만 본다. 시각까지 비교하면 같은 날 더 늦게 찍힌 다른 도로가 뽑힌다. */
function photoDay(candidate: PanoCandidate) {
  return String(candidate.photodate ?? '').slice(0, 10)
}

function closest(candidates: ScoredCandidate[]) {
  return candidates.reduce((best, c) => (c.distanceM < best.distanceM ? c : best))
}

/**
 * 후보 중 주차장을 가장 잘 비출 파노라마를 고른다.
 *
 * ```
 * 최근접이 30m 이내        → 최근접
 * 촬영일 최신 그룹 → 최근접 → 최근접 대비 +60m 초과면 되돌림
 * ```
 */
export function selectPanorama(
  candidates: PanoCandidate[],
  lotLat: number,
  lotLng: number,
): RoadviewSelection | null {
  const scored: ScoredCandidate[] = candidates.map((c) => ({
    ...c,
    distanceM: getDistance(lotLat, lotLng, c.lat, c.lng) * 1000,
  }))
  if (scored.length === 0) return null

  const nearest = closest(scored)
  const base = { nearest, candidateCount: scored.length }

  if (nearest.distanceM <= NEAR_ENOUGH_M) {
    return { ...base, chosen: nearest, reason: 'near-enough' }
  }

  const latestDay = scored.reduce((latest, c) => {
    const day = photoDay(c)
    return day > latest ? day : latest
  }, '')
  const chosen = closest(scored.filter((c) => photoDay(c) === latestDay))

  if (chosen.panoId === nearest.panoId) {
    return { ...base, chosen: nearest, reason: 'nearest-is-latest' }
  }
  if (chosen.distanceM - nearest.distanceM > MAX_JUMP_M) {
    return { ...base, chosen: nearest, reason: 'jump-capped' }
  }
  return { ...base, chosen, reason: 'latest-date' }
}
