/**
 * 목적지 발행 게이트 (#166, 기획 5-3절)
 *
 * 순수 함수다. DB 도 파일도 만지지 않는다. scripts/near/ 가 쓰고, 테스트는 src 에서 돈다. 후보 하나와 주변 주차장 배열을 받아
 * "발행할 수 있는가" 와 "왜 안 되는가" 를 돌려준다. 이 함수를 통과하지 못한 목적지는
 * destinations 에 행이 생기지 않는다 — 빈 페이지를 만들지 않는 장치가 여기다.
 */

export interface Candidate {
  name: string
  lat: number | null
  lng: number | null
}

export interface CandidateLot {
  id: string
  name: string
  lat: number
  lng: number
  totalSpaces: number
  isFree: boolean
  baseFee: number | null
  /** 목적지 이름을 제목·본문에 담은 web_source id. 없으면 null */
  evidenceSourceId: number | null
}

export interface GateOptions {
  radiusM: number
  minLots: number
  /** 요금(무료 플래그 또는 base_fee>0) 또는 면수를 아는 주차장의 최소 수 */
  minLotsWithData: number
  minEvidence: number
}

export const DEFAULT_GATE: GateOptions = {
  radiusM: 1000,
  minLots: 3,
  minLotsWithData: 2,
  minEvidence: 1,
}

export interface RankedLot extends CandidateLot {
  distanceM: number
  rank: number
}

export type GateResult =
  | { pass: true; lots: RankedLot[]; freeCount: number; twins: [string, string][] }
  | { pass: false; reason: GateFailReason; detail: string }

export type GateFailReason = 'no_coords' | 'too_few_lots' | 'too_few_lots_with_data' | 'no_evidence'

const EARTH_R = 6371000
// 면수가 같은(0 제외) 두 행이 100m 안에 있으면 같은 주차장이다. 60m 로는 석촌역의
// "송파근린공원주차장 / 송파근린공원 공영주차장"(324면, 62m) 이 빠져나가 라이브에 둘 다 실렸다
const TWIN_RADIUS_M = 100

/** 두 좌표 사이 직선거리(m). 하버사인 */
export function distanceMeters(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_R * Math.asin(Math.sqrt(h))
}

/** 요금이나 면수 중 하나라도 "아는" 주차장인가. 비교표에 빈 줄이 되지 않을 주차장 */
export function hasUsableData(lot: CandidateLot): boolean {
  return lot.isFree || (lot.baseFee ?? 0) > 0 || lot.totalSpaces > 0
}

/**
 * 같은 주차장이 KA-/공공데이터 id 로 두 번 들어오는 것을 막는다 (기획 R-1).
 * 좌표 소수 4자리(약 11m)와 면수가 같으면 같은 주차장으로 본다.
 * 공공데이터 id 를 남기고 KA-/NV- 를 버린다. 버린 쌍은 twins 로 돌려준다.
 */
export function dedupeTwins(lots: CandidateLot[]): {
  kept: CandidateLot[]
  twins: [string, string][]
} {
  const isPublic = (id: string) => !/^(KA|NV)-/.test(id)
  const kept: CandidateLot[] = []
  const twins: [string, string][] = []
  for (const lot of lots) {
    // 같은 주차장으로 보는 기준: 60m 안이고 면수가 같다 (면수를 모르는 0면끼리는 묶지 않는다 —
    // 노상 구역처럼 진짜 다른 곳이 많다). 스모크에서 "송파근린공원주차장/송파근린공원 공영주차장"
    // 324면 쌍이 12m 차이로 4자리 좌표 비교를 빠져나갔다.
    const i = kept.findIndex(
      (k) =>
        k.totalSpaces > 0 &&
        k.totalSpaces === lot.totalSpaces &&
        distanceMeters(k.lat, k.lng, lot.lat, lot.lng) <= TWIN_RADIUS_M,
    )
    if (i < 0) {
      kept.push(lot)
      continue
    }
    const prev = kept[i]
    // 둘 중 공공데이터 쪽을 남긴다. 둘 다 아니면 먼저 온 것을 남긴다
    if (!isPublic(prev.id) && isPublic(lot.id)) {
      kept[i] = lot
      twins.push([lot.id, prev.id])
    } else {
      twins.push([prev.id, lot.id])
    }
  }
  return { kept, twins }
}

export function evaluateGate(
  candidate: Candidate,
  lotsInBbox: CandidateLot[],
  opts: GateOptions = DEFAULT_GATE,
): GateResult {
  if (candidate.lat === null || candidate.lng === null) {
    return { pass: false, reason: 'no_coords', detail: '좌표 없음' }
  }
  const { lat, lng } = candidate

  const deduped = dedupeTwins(lotsInBbox)
  const inRadius = deduped.kept
    .map((lot) => ({ lot, distanceM: Math.round(distanceMeters(lat, lng, lot.lat, lot.lng)) }))
    .filter((x) => x.distanceM <= opts.radiusM)
    .sort((a, b) => a.distanceM - b.distanceM)

  if (inRadius.length < opts.minLots) {
    return {
      pass: false,
      reason: 'too_few_lots',
      detail: `반경 ${opts.radiusM}m 내 ${inRadius.length}곳 (필요 ${opts.minLots})`,
    }
  }

  const withData = inRadius.filter((x) => hasUsableData(x.lot)).length
  if (withData < opts.minLotsWithData) {
    return {
      pass: false,
      reason: 'too_few_lots_with_data',
      detail: `요금·면수 아는 곳 ${withData}곳 (필요 ${opts.minLotsWithData})`,
    }
  }

  const evidence = inRadius.filter((x) => x.lot.evidenceSourceId !== null).length
  if (evidence < opts.minEvidence) {
    return {
      pass: false,
      reason: 'no_evidence',
      detail: `목적지를 언급한 web_source 연결 ${evidence}건 (필요 ${opts.minEvidence})`,
    }
  }

  const lots: RankedLot[] = inRadius.map((x, i) => ({
    ...x.lot,
    distanceM: x.distanceM,
    rank: i + 1,
  }))
  return { pass: true, lots, freeCount: lots.filter((l) => l.isFree).length, twins: deduped.twins }
}
