/**
 * 주차장 정보 모음 사이트(경쟁 애그리게이터) 차단 목록
 *
 * 이들은 후기가 아니라 우리와 같은 공공데이터를 재배포하는 사이트다.
 * 후기로 취급하면 세 가지가 한꺼번에 망가진다.
 *   1. 요약·평점 집계에 경쟁사 페이지가 섞인다
 *   2. 사용자에게 경쟁사 링크를 노출한다
 *   3. 고유 콘텐츠가 없는 페이지에 "외부 콘텐츠 있음" 색인 신호를 준다
 *
 * 목록 출처와 갱신 방법: docs/references/competitors.md
 * (우리 web_sources 를 도메인별로 집계해 lot 커버리지가 넓은 곳을 추린 것)
 */

/** 차단 도메인. 서브도메인까지 포함해 판정한다 (`a.b.com` 은 `b.com` 규칙에 걸린다). */
export const AGGREGATOR_DOMAINS = [
  'placeview.co.kr',
  'dodam-platform.com',
  'platformdodam.com',
  'siteinfor.co.kr',
  'parking.loveash.kr',
  'ilsangkit.co.kr',
  'parking.mustarddata.com',
  'jucha.kr',
  'parking.govpped.com',
  'parking.worldtourlist.com',
  'junkangworld.com',
  'k114.co.kr',
  'carhub.co.kr',
  'locategrid.com',
  'store114.net',
  'visit.pluconnect.com',
  'parking.netfilcker.com',
  'place.udanax.org',
  'car.bonuscookie.com',
  // 우리 사이트. 크롤러가 자기 사이트를 긁어 되먹임하는 것을 막는다 (2026-09-02 기준 499 lot 유입).
  'easy-parking.xyz',

  // ── 2026-09-02 감사에서 추가로 확인된 곳 ──
  // 페이지를 직접 열어 "공공데이터 재배포"임을 확인한 것만 넣었다.
  // 공공데이터포털 표준데이터를 그대로 싣는다 ("전국 자전거 대여소/보관소 지도" 계열, 45 lot)
  'purpleo.co.kr',
  // "서울 무료주차장·공영주차장 지도" (29 lot)
  'parkingmap.kr',
  // "전국 공영주차장 요금, 위치, 후기... 공공데이터를 기준으로" (35 lot)
  'product-pack.com',
] as const

const BLOCKED = new Set<string>(AGGREGATOR_DOMAINS)

/** URL 에서 호스트만 뽑는다. 스킴·www·포트·대소문자를 정규화한다. */
export function extractHost(url: string): string | null {
  if (!url) return null
  const trimmed = url.trim()
  if (!trimmed) return null

  let rest = trimmed
  const schemeEnd = rest.indexOf('://')
  if (schemeEnd !== -1) rest = rest.slice(schemeEnd + 3)

  // 경로/쿼리/프래그먼트 제거
  rest = rest.split(/[/?#]/)[0]
  // 인증정보 제거
  const at = rest.lastIndexOf('@')
  if (at !== -1) rest = rest.slice(at + 1)
  // 포트 제거
  rest = rest.split(':')[0]

  rest = rest.toLowerCase().replace(/^www\./, '')
  return rest || null
}

/** 이 URL 이 정보 모음 사이트인가 */
export function isAggregatorUrl(url: string | null | undefined): boolean {
  if (!url) return false
  const host = extractHost(url)
  if (!host) return false
  if (BLOCKED.has(host)) return true
  // 서브도메인 매칭: news.k114.co.kr → k114.co.kr
  return AGGREGATOR_DOMAINS.some((d) => host.endsWith(`.${d}`))
}

/** 소급 마킹·조회에 쓰는 사유 문자열 (web_sources.filter_v2_reason) */
export const AGGREGATOR_REASON = 'aggregator_site'
