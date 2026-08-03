/**
 * Kakao Local 키워드검색 REST 클라이언트
 *
 * 신규 lot 확정용: Naver로 발견한 후보를 Kakao로 교차검증하여 안정적인
 * KA-{id} 채번 + WGS84 좌표를 확보한다. (계획: missed-web-sources-new-parking-lots.plan.md)
 *
 * 기존 enrich-kakao-place.ts는 아는 placeId를 Playwright로 스크래핑할 뿐
 * 이름검색 기능이 없어 별도 작성. 이 API는 응답 id로 KA-{id}를 바로 만들 수 있고
 * x/y가 WGS84 경위도 그대로다.
 *
 * 환경변수: KAKAO_REST_API_KEY
 * https://developers.kakao.com/docs/latest/ko/local/dev-guide#search-by-keyword
 */

const KEYWORD_URL = 'https://dapi.kakao.com/v2/local/search/keyword.json'

/** Kakao 주차장 카테고리 그룹 코드 */
export const KAKAO_PARKING_CODE = 'PK6'

export interface KakaoPlace {
  id: string
  place_name: string
  category_name: string
  category_group_code: string // 'PK6' = 주차장
  phone: string
  address_name: string
  road_address_name: string
  x: string // 경도(WGS84)
  y: string // 위도(WGS84)
  place_url: string
}

interface KakaoKeywordResponse {
  documents: KakaoPlace[]
  meta: { total_count: number; pageable_count: number; is_end: boolean }
}

function getHeaders(): Record<string, string> {
  const key = process.env.KAKAO_REST_API_KEY
  if (!key) throw new Error('KAKAO_REST_API_KEY가 설정되지 않았습니다.')
  return { Authorization: `KakaoAK ${key}` }
}

/**
 * Kakao Local 키워드검색. 429 시 지정 시간 대기 후 1회 재시도.
 * @param query 검색어
 * @param size 결과 수 (1~15)
 * @param categoryCode 카테고리 그룹 코드로 제한 (예: 'PK6'). 미지정 시 전체.
 */
export async function searchKakaoKeyword(
  query: string,
  size = 15,
  categoryCode?: string,
  retryDelayMs = 5_000,
): Promise<KakaoPlace[]> {
  const params = new URLSearchParams({ query, size: String(size), page: '1' })
  if (categoryCode) params.set('category_group_code', categoryCode)
  const url = `${KEYWORD_URL}?${params}`

  let res = await fetch(url, { headers: getHeaders() })
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, retryDelayMs))
    res = await fetch(url, { headers: getHeaders() })
  }
  if (!res.ok) throw new Error(`Kakao Local API ${res.status}: ${await res.text()}`)
  return ((await res.json()) as KakaoKeywordResponse).documents ?? []
}

/** Kakao 결과가 주차장 계열인지 (카테고리 코드 또는 이름) */
export function isKakaoParking(p: KakaoPlace): boolean {
  return p.category_group_code === KAKAO_PARKING_CODE || /주차/.test(p.place_name)
}

/** Kakao x/y(문자열 WGS84) → 위경도 숫자 */
export function parseKakaoCoords(p: KakaoPlace): { lat: number; lng: number } {
  return { lat: parseFloat(p.y), lng: parseFloat(p.x) }
}
