/**
 * 네이버 블로그/카페 검색 API 래퍼
 *
 * 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET
 * https://developers.naver.com/docs/serviceapi/search/blog/blog.md
 */

const BLOG_URL = 'https://openapi.naver.com/v1/search/blog.json'
const CAFE_URL = 'https://openapi.naver.com/v1/search/cafearticle.json'
const LOCAL_URL = 'https://openapi.naver.com/v1/search/local.json'

interface NaverSearchItem {
  title: string
  link: string
  description: string
  bloggername?: string
  cafename?: string
  cafeurl?: string
  postdate?: string // "20240101" 형태
}

interface NaverSearchResponse {
  lastBuildDate: string
  total: number
  start: number
  display: number
  items: NaverSearchItem[]
}

export type { NaverSearchItem, NaverSearchResponse }

function getHeaders(): Record<string, string> {
  const clientId = process.env.NAVER_CLIENT_ID
  const clientSecret = process.env.NAVER_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('NAVER_CLIENT_ID / NAVER_CLIENT_SECRET가 설정되지 않았습니다.')
  }
  return {
    'X-Naver-Client-Id': clientId,
    'X-Naver-Client-Secret': clientSecret,
  }
}

/** 네이버 블로그 검색 */
export async function searchNaverBlog(
  query: string,
  display = 10,
  start = 1,
): Promise<NaverSearchResponse> {
  const params = new URLSearchParams({
    query,
    display: String(display),
    start: String(start),
    sort: 'sim',
  })
  const res = await fetch(`${BLOG_URL}?${params}`, { headers: getHeaders() })
  if (!res.ok) throw new Error(`Naver Blog API ${res.status}: ${await res.text()}`)
  return res.json() as Promise<NaverSearchResponse>
}

/** 네이버 카페 검색 */
export async function searchNaverCafe(
  query: string,
  display = 10,
  start = 1,
): Promise<NaverSearchResponse> {
  const params = new URLSearchParams({
    query,
    display: String(display),
    start: String(start),
    sort: 'sim',
  })
  const res = await fetch(`${CAFE_URL}?${params}`, { headers: getHeaders() })
  if (!res.ok) throw new Error(`Naver Cafe API ${res.status}: ${await res.text()}`)
  return res.json() as Promise<NaverSearchResponse>
}

interface NaverLocalItem {
  title: string // <b> 태그 포함 가능
  link: string
  category: string
  description: string
  telephone: string
  address: string
  roadAddress: string
  mapx: string // 경도(WGS84) × 10^7
  mapy: string // 위도(WGS84) × 10^7
}

interface NaverLocalResponse {
  lastBuildDate: string
  total: number
  start: number
  display: number
  items: NaverLocalItem[]
}

export type { NaverLocalItem, NaverLocalResponse }

/**
 * 네이버 지역(장소) 검색
 * https://developers.naver.com/docs/serviceapi/search/local/local.md
 * 429 시 지정 시간 대기 후 1회 재시도.
 */
export async function searchNaverLocal(
  query: string,
  display = 5,
  retryDelayMs = 10_000,
): Promise<NaverLocalItem[]> {
  const params = new URLSearchParams({
    query,
    display: String(display),
    start: '1',
    sort: 'comment',
  })
  const res = await fetch(`${LOCAL_URL}?${params}`, { headers: getHeaders() })
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, retryDelayMs))
    const retry = await fetch(`${LOCAL_URL}?${params}`, { headers: getHeaders() })
    if (!retry.ok) throw new Error(`Naver Local API ${retry.status}: ${await retry.text()}`)
    return ((await retry.json()) as NaverLocalResponse).items ?? []
  }
  if (!res.ok) throw new Error(`Naver Local API ${res.status}: ${await res.text()}`)
  return ((await res.json()) as NaverLocalResponse).items ?? []
}

/** 네이버 지역검색 mapx/mapy(WGS84 × 10^7) → 위경도 */
export function parseNaverCoords(mapx: string, mapy: string): { lat: number; lng: number } {
  return {
    lng: parseInt(mapx, 10) / 10_000_000,
    lat: parseInt(mapy, 10) / 10_000_000,
  }
}

/** 한국 영토 좌표 범위 검증 */
export function isInKorea(lat: number, lng: number): boolean {
  return lat >= 33 && lat <= 39 && lng >= 124 && lng <= 132
}

/** 네이버 검색 결과에 포함된 HTML 태그 및 엔티티 제거 */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .trim()
}

/** "20240101" → "2024-01-01" */
export function parsePostdate(dateStr: string | undefined): string | null {
  if (!dateStr || dateStr.length !== 8) return null
  return `${dateStr.slice(0, 4)}-${dateStr.slice(4, 6)}-${dateStr.slice(6, 8)}`
}

/** URL → SHA-256 앞 16자 해시 (dedup 용) */
export async function hashUrl(url: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(url)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}
