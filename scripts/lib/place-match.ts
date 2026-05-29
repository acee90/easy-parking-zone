/**
 * 장소검색 결과 → 신규/기존/노이즈 판정 공통 로직
 *
 * Naver Local Search 결과를 기존 parking_lots와 좌표 dedup하고
 * 블로그 본문 지역 힌트 + 관련성 게이트로 단일 신규 lot을 확정한다.
 *
 * search-place-candidates.ts(측정)와 resolve-missed.ts(해소)에서 공통 사용.
 */

import { d1Query } from './d1'
import { haversineMeters } from './geo'
import { isInKorea, type NaverLocalItem, parseNaverCoords, stripHtml } from './naver-api'

// 목표 지향 라벨:
//  resolved_new   — 단일 신규 lot 확정 (기존 DB에 없음, 관련성 통과)
//  ambiguous_new  — 신규 후보 여러 개, 본문 힌트로도 미확정
//  all_existing   — 주차장 결과는 있으나 전부 기존 parking_lots와 중복
//  negative       — 주차장 결과 없음
export type PlaceLabel = 'resolved_new' | 'ambiguous_new' | 'all_existing' | 'negative'

export interface PlaceResult {
  name: string
  category: string
  address: string
  road_address: string
  lat: number
  lng: number
  telephone: string
  is_parking: boolean
}

export interface AnnotatedResult extends PlaceResult {
  is_existing: boolean
  existing_lot_id: string | null
  existing_dist_m: number | null
  region_score: number
}

export interface ExistingLot {
  id: string
  name: string
  lat: number
  lng: number
}

export interface PlaceOutcome {
  label: PlaceLabel
  parking_result_count: number
  new_result_count: number
  best: AnnotatedResult | null
}

export function loadExistingLots(): ExistingLot[] {
  return d1Query<ExistingLot>('SELECT id, name, lat, lng FROM parking_lots WHERE lat IS NOT NULL')
}

// bbox 선필터(±0.003도 ≈ 330m) 후 haversine으로 최근접 lot 탐색
export function nearestLot(
  lat: number,
  lng: number,
  lots: ExistingLot[],
): { lot: ExistingLot; dist: number } | null {
  let best: ExistingLot | null = null
  let bestD = Infinity
  for (const l of lots) {
    if (Math.abs(l.lat - lat) > 0.003 || Math.abs(l.lng - lng) > 0.003) continue
    const d = haversineMeters(lat, lng, l.lat, l.lng)
    if (d < bestD) {
      bestD = d
      best = l
    }
  }
  return best ? { lot: best, dist: bestD } : null
}

// 블로그 본문 지역 힌트 (구/동/로/길)
const HINT_RE = /([가-힣]{2,}(?:구|군|동|읍|면|리|로|길))/g
export function extractHints(text: string): Set<string> {
  const hints = new Set<string>()
  let m: RegExpExecArray | null
  HINT_RE.lastIndex = 0
  while ((m = HINT_RE.exec(text)) !== null) hints.add(m[1])
  return hints
}

function regionScore(addr: string, hints: Set<string>): number {
  if (hints.size === 0) return 0
  let score = 0
  for (const h of hints) if (addr.includes(h)) score++
  return score
}

export function toPlaceResult(item: NaverLocalItem): PlaceResult {
  const name = stripHtml(item.title)
  const { lat, lng } = parseNaverCoords(item.mapx, item.mapy)
  const isParking = item.category.includes('주차') || name.includes('주차')
  return {
    name,
    category: item.category,
    address: item.address,
    road_address: item.roadAddress,
    lat,
    lng,
    telephone: item.telephone,
    is_parking: isParking,
  }
}

function annotate(
  r: PlaceResult,
  lots: ExistingLot[],
  hints: Set<string>,
  dedupRadiusM: number,
): AnnotatedResult {
  const near = nearestLot(r.lat, r.lng, lots)
  const isExisting = near !== null && near.dist <= dedupRadiusM
  return {
    ...r,
    is_existing: isExisting,
    existing_lot_id: isExisting ? near!.lot.id : null,
    existing_dist_m: near ? Math.round(near.dist) : null,
    region_score: regionScore(`${r.address} ${r.road_address}`, hints),
  }
}

// 관련성 검증: region_score(주소 지역 일치)가 있거나 결과명이 후보 핵심 토큰을 포함하면 관련 있다고 본다.
function candidateCoreTokens(name: string): string[] {
  return name
    .replace(/(공영|민영|지하|노상|노외|부설|공공)?\s*(주차장|파킹|parking)/gi, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
}

// 관련성: 블로그 지역힌트가 결과 주소와 일치(region_score>0)하거나, 검색명 핵심 토큰이
// 검색 "결과명"에 포함되면 관련 있다고 본다. (DB lot명이 아니라 Naver 결과명 기준 —
// 좌표회수는 이름이 다른 경우용이므로 DB lot명 기반 게이트는 부적합.)
export function isRelevant(candidate: string, r: AnnotatedResult): boolean {
  if (r.region_score > 0) return true
  return candidateCoreTokens(candidate).some((t) => r.name.includes(t))
}

/**
 * 장소검색 결과를 신규/기존/노이즈로 판정.
 * @param candidateName 정규화된 후보 장소명 (관련성 검증용)
 * @param items Naver Local Search 결과
 * @param lots 기존 parking_lots
 * @param hints 블로그 본문 지역 힌트
 * @param dedupRadiusM 기존 lot 중복 판정 반경(m)
 */
export function resolvePlace(
  candidateName: string,
  items: NaverLocalItem[],
  lots: ExistingLot[],
  hints: Set<string>,
  dedupRadiusM: number,
): PlaceOutcome {
  const parking = items
    .map(toPlaceResult)
    .filter((r) => r.is_parking && isInKorea(r.lat, r.lng))
    .map((r) => annotate(r, lots, hints, dedupRadiusM))

  const newResults = parking.filter((r) => !r.is_existing)

  let label: PlaceLabel
  let best: AnnotatedResult | null = null

  if (parking.length === 0) {
    label = 'negative'
  } else if (newResults.length === 0) {
    label = 'all_existing'
    best = [...parking].sort((a, b) => (a.existing_dist_m ?? 1e9) - (b.existing_dist_m ?? 1e9))[0]
  } else if (newResults.length === 1) {
    best = newResults[0]
    label = isRelevant(candidateName, best) ? 'resolved_new' : 'ambiguous_new'
  } else {
    const sorted = [...newResults].sort((a, b) => b.region_score - a.region_score)
    const topScore = sorted[0].region_score
    const topCount = sorted.filter((r) => r.region_score === topScore).length
    best = sorted[0]
    label = topScore > 0 && topCount === 1 ? 'resolved_new' : 'ambiguous_new'
  }

  return { label, parking_result_count: parking.length, new_result_count: newResults.length, best }
}
