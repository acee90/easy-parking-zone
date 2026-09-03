/**
 * 검색어 정규화 — "석촌역 근처 주차장"처럼 사람들이 실제로 입력하는 어투에서
 * 핵심 키워드("석촌역")만 남긴다.
 *
 * 배경: 검색 경로 두 개가 자연어 검색어에서 동시에 0건을 반환했다.
 * - `searchParkingLots`는 모든 단어를 AND로 묶으므로 "근처"가 매칭에 실패
 * - `searchPlaces`는 카카오 응답에서 주차장 카테고리를 통째로 제외
 * 자세한 진단은 docs/exec-plans/issue-166-destination-pages.md 1-2절 참고.
 */

import type { ParkingLot, Place } from '@/types/parking'

/** 통째로 지우는 단어 — 목적지를 특정하지 못하는 탐색 표현 */
const STOP_WORDS = new Set([
  '근처',
  '주변',
  '인근',
  '가까운',
  '주차',
  '주차장',
  '무료주차',
  '무료주차장',
  '유료주차',
  '유료주차장',
  '공영주차장',
  '공영주차',
])

/**
 * 접미사만 떼면 의미가 남지 않는 수식어.
 * "무료주차장" → "무료"처럼 알맹이 없는 키워드가 생기는 것을 막는다.
 */
const BARE_MODIFIERS = new Set([
  '무료',
  '유료',
  '공영',
  '민영',
  '노상',
  '노외',
  '지하',
  '공용',
  '실내',
  '옥외',
])

const ATTACHED_SUFFIXES = ['주차장', '주차']

/** 붙여 쓴 "석촌역주차장" → "석촌역". 남는 앞부분이 의미 없으면 원본 유지 */
function stripAttachedSuffix(word: string): string {
  for (const suffix of ATTACHED_SUFFIXES) {
    if (!word.endsWith(suffix) || word === suffix) continue
    const prefix = word.slice(0, -suffix.length)
    if (prefix.length < 2 || BARE_MODIFIERS.has(prefix)) continue
    return prefix
  }
  return word
}

export interface NormalizedQuery {
  /** 입력을 공백으로 쪼갠 원본 단어들 */
  original: string[]
  /** 탐색 표현을 걷어낸 핵심 단어들 (비면 original과 동일) */
  core: string[]
}

/**
 * 검색어를 원본 단어와 핵심 단어로 분해한다.
 *
 * 불변식: `core`의 모든 단어는 `original`의 어떤 단어의 부분 문자열이다.
 * 따라서 core 조건은 original 조건보다 항상 느슨하며(original ⊆ core),
 * 이 성질 덕분에 기존 주차장명 검색 결과가 사라지지 않는다.
 */
export function normalizeSearchQuery(raw: string): NormalizedQuery {
  const original = raw
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 1)

  const core = original.filter((w) => !STOP_WORDS.has(w)).map(stripAttachedSuffix)

  // 검색어가 전부 탐색 표현이면("공영주차장") 원본 그대로 검색한다
  if (core.length === 0) return { original, core: original }

  return { original, core }
}

/** 정규화된 핵심 검색어를 문자열로 되돌린다 */
export function coreQueryString(raw: string): string {
  return normalizeSearchQuery(raw).core.join(' ')
}

/** 비교용 정규화 — 공백 제거 + 소문자 */
function canonicalName(value: string): string {
  return value.replace(/\s+/g, '').toLowerCase()
}

/**
 * 카카오 장소 결과 중 우리 DB 주차장 목록과 이름이 겹치는 항목을 제거한다.
 * (좌표·주소는 비교에 쓰지 않는다 — 이름만으로 충분하다)
 */
export function dedupePlacesAgainstLots(places: Place[], lots: ParkingLot[]): Place[] {
  if (lots.length === 0) return places
  const lotNames = new Set(lots.map((lot) => canonicalName(lot.name)))
  return places.filter((place) => !lotNames.has(canonicalName(place.name)))
}

export interface KakaoPlaceDocument {
  place_name: string
  address_name: string
  x: string
  y: string
  category_group_name: string
}

/**
 * 카카오 로컬 응답 → Place[].
 *
 * 주차장 카테고리를 제외하지 않는다. "석촌역 근처 주차장"처럼 사람들이 쓰는
 * 검색어에서는 카카오가 주차장만 돌려주므로, 제외하면 결과가 0건이 된다.
 * 대신 목적지 성격이 강한 비-주차장 결과를 앞에 놓고, UI가 카테고리를 표시한다.
 */
export function parseKakaoPlaces(documents: KakaoPlaceDocument[]): Place[] {
  const places = documents.map((d) => ({
    name: d.place_name,
    address: d.address_name,
    lat: parseFloat(d.y),
    lng: parseFloat(d.x),
    category: d.category_group_name || undefined,
  }))

  // 주차장 카테고리는 뒤로 — 목적지(역·상업시설·관광지)가 먼저 보여야 한다
  const isParking = (p: Place) => p.category === '주차장'
  return [...places.filter((p) => !isParking(p)), ...places.filter(isParking)]
}

/** 이름+주소가 같은 장소를 앞선 항목 우선으로 합친다 */
export function mergePlaces(...groups: Place[][]): Place[] {
  const seen = new Set<string>()
  const merged: Place[] = []
  for (const group of groups) {
    for (const place of group) {
      const key = `${canonicalName(place.name)}|${canonicalName(place.address)}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(place)
    }
  }
  return merged
}
