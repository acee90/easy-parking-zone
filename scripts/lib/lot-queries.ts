/**
 * 주차장 lot용 검색 쿼리 빌더 (공통)
 *
 * 모든 쿼리에 "주차" 키워드를 강제 포함하여 백화점/맛집 후기 등 노이즈를 줄임.
 * crawl-blogs.ts (Naver) / crawl-ddg.ts (DuckDuckGo) 양쪽에서 공유.
 */
import { extractRegion, isGenericName } from './geo'

export type QueryStrategy =
  | 'name_region' // {이름} 주차장 {지역}
  | 'review' //     {이름} 주차 후기
  | 'price' //      {이름} 주차 요금
  | 'free' //       {이름} 무료주차
  | 'hours' //      {이름} 주차 운영시간
  | 'poi' //        {POI} 주차장
  | 'region' //     {지역} 주차장 (generic fallback)

export interface LotQuery {
  strategy: QueryStrategy
  query: string
}

export interface LotInput {
  name: string
  address: string
  /** JSON 문자열 또는 파싱된 배열 둘 다 허용 (D1 컬럼은 TEXT) */
  poiTags?: string[] | string | null
}

/**
 * lot.name 에서 '주차장', '공영주차장', '노외주차장' 등 접미사를 떼어
 * 검색용 baseName 을 만든다. 너무 짧아지면 원본 유지.
 */
function extractBaseName(name: string): string {
  const stripped = name
    .replace(/(공영|노외|노상|부설|민영|시영|구영)?\s*주차장$/g, '')
    .replace(/주차타워$/g, '')
    .trim()
  return stripped.length >= 2 ? stripped : name
}

function parsePoiTags(poiTags: string[] | string | null | undefined): string[] {
  if (!poiTags) return []
  if (Array.isArray(poiTags)) return poiTags
  try {
    const parsed = JSON.parse(poiTags)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/**
 * lot 1개 → 표준 6쿼리 빌더 (POI 없으면 5쿼리)
 *
 * - 모든 쿼리에 "주차" 키워드 포함 (백화점 후기 등 노이즈 차단)
 * - generic 이름(예: "제1주차장")은 region 단일 쿼리로 fallback
 */
export function buildLotQueries(lot: LotInput): LotQuery[] {
  const region = extractRegion(lot.address)

  // Generic 이름: region 단일 fallback (호출 측에서 스킵해도 무방)
  if (isGenericName(lot.name)) {
    if (!region) return []
    return [{ strategy: 'region', query: `${region} 주차장 추천` }]
  }

  const base = extractBaseName(lot.name)
  const queries: LotQuery[] = [
    { strategy: 'name_region', query: `${base} 주차장 ${region}`.trim() },
    { strategy: 'review', query: `${base} 주차 후기` },
    { strategy: 'price', query: `${base} 주차 요금` },
    { strategy: 'free', query: `${base} 무료주차` },
    { strategy: 'hours', query: `${base} 주차 운영시간` },
  ]

  const pois = parsePoiTags(lot.poiTags ?? null)
  if (pois.length > 0) {
    queries.push({ strategy: 'poi', query: `${pois[0]} 주차장` })
  }

  return queries
}
