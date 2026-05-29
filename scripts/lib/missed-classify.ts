/**
 * missed_lot_name 분류 — candidate_type 판정
 *
 * web_sources_missed의 추출된 장소명을 정규화하고
 * parking_lot_name / facility_name / region_name / organization_name /
 * generic_term / page_or_service / unknown 으로 분류한다.
 *
 * discover-missed-parking-lots.ts(집계)와 resolve-missed.ts(해소)에서 공통 사용.
 */

export type CandidateType =
  | 'parking_lot_name'
  | 'facility_name'
  | 'region_name'
  | 'organization_name'
  | 'generic_term'
  | 'page_or_service'
  | 'unknown'

export const GENERIC_TERMS = new Set([
  '지하',
  '주차',
  '주차장',
  '노상',
  '노외',
  '부설',
  '민영',
  '공영',
  '지하주차장',
  '공영주차장',
  '노상공영',
  '노외주차장',
  '민영주차장',
  '공영주차',
])

const PAGE_SERVICE_RE =
  /(플레이스뷰|포털|포탈|홈페이지|블로그|카페|채용공고|구인구직|공공근로|게시판|바로가기|예매|상영시간표|실시간|CGV|롯데시네마|메가박스|Instagram|인스타그램|영화)/i

// 추출 파편/불용어: 주차장 근처에서 잘못 추출된 일반 수식어·상태어·홍보어. 단독이면 lot명이 아님.
export const FRAGMENT_WORDS = new Set([
  '넓은',
  '좁은',
  '유료',
  '무료',
  '직영',
  '민간위탁',
  '위탁',
  '공공',
  '전국',
  '상세',
  '가까운',
  '임시',
  '임시공영',
  '시민행복',
  '행복',
  '개방',
  '무료개방',
  '연휴',
  '추석연휴',
  '설연휴',
  '명절',
  '할인',
  '예매',
  '실시간',
  '상영시간표',
  '자투리',
  '활용',
  '생활',
  '본사',
  '아파트',
  '종합',
  '무인',
  '만차',
  '빈자리',
  '추천',
  '근처',
  '주변',
  '인근',
  '일대',
  '입구',
  '출구',
  '정문',
  '후문',
  '바로',
  '전용',
  '간이',
  '임시개방',
])

const ORG_RE =
  /(도시개발공사|도시관리공사|시설관리공단|도시공사|공사|공단|통합관리|운영사|관리사무소)/
const PARKING_RE = /(주차장|파킹|parking)/i
export const STRONG_PARKING_RE =
  /(공영주차장|민영주차장|지하주차장|부설주차장|제\s*\d+\s*주차장|파킹|parking)/i
// 행정구역/역명: 마지막 토큰이 시/군/구/읍/면/리/동/가/역으로 끝나거나 전체가 광역 단위.
const ADMIN_TAIL_RE = /(시|군|구|읍|면|리|동|가|역)$/
const PROVINCE_RE =
  /^(서울특별시|부산광역시|대구광역시|인천광역시|광주광역시|대전광역시|울산광역시|세종특별자치시|경기도|강원특별자치도|강원도|충청북도|충청남도|전라북도|전북특별자치도|전라남도|경상북도|경상남도|제주특별자치도|경기|강원|충북|충남|전북|전남|경북|경남|제주|세종)$/
const MAX_NAME_LEN = 40

export function normalizeName(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[[("'·-]+/, '')
    .replace(/[\])"'·-]+$/, '')
    .trim()
}

function isRegionName(n: string): boolean {
  const tokens = n.split(/\s+/)
  const last = tokens[tokens.length - 1]
  if (last.length >= 2 && ADMIN_TAIL_RE.test(last)) return true
  if (tokens.every((t) => PROVINCE_RE.test(t))) return true
  return false
}

// 파편/불용어·일반명을 제거하고 남는 "실제 장소를 가리키는" 토큰
export function meaningfulTokens(s: string): string[] {
  return s
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !FRAGMENT_WORDS.has(t) && !GENERIC_TERMS.has(t))
}

export function classify(n: string): { type: CandidateType; reason: string } {
  if (n.length === 0) return { type: 'unknown', reason: 'empty' }
  if (n.length > MAX_NAME_LEN) return { type: 'unknown', reason: 'too_long_descriptive' }
  if (PAGE_SERVICE_RE.test(n)) return { type: 'page_or_service', reason: 'page/service keyword' }
  if (GENERIC_TERMS.has(n)) return { type: 'generic_term', reason: 'bare generic term' }
  if (PARKING_RE.test(n)) {
    const residual = n.replace(
      /(공영|민영|지하|노상|노외|부설|공공)?\s*(주차장|파킹|parking)/gi,
      '',
    )
    if (meaningfulTokens(residual).length >= 1) {
      return { type: 'parking_lot_name', reason: 'parking keyword + distinct prefix' }
    }
    return { type: 'generic_term', reason: 'parking keyword without distinct name' }
  }
  if (ORG_RE.test(n)) return { type: 'organization_name', reason: 'org/company keyword' }
  if (isRegionName(n)) return { type: 'region_name', reason: 'region/admin/station name' }
  if (meaningfulTokens(n).length === 0) {
    return { type: 'generic_term', reason: 'extraction fragment/stopword only' }
  }
  return { type: 'facility_name', reason: 'facility name, needs "{name} 주차장" search' }
}

const BASE_CONFIDENCE: Record<CandidateType, number> = {
  parking_lot_name: 0.7,
  facility_name: 0.5,
  organization_name: 0.3,
  region_name: 0.2,
  generic_term: 0.1,
  page_or_service: 0.05,
  unknown: 0.2,
}

export function confidence(
  type: CandidateType,
  normalized: string,
  evidenceCount: number,
  sourceCount: number,
): number {
  let c = BASE_CONFIDENCE[type]
  if (STRONG_PARKING_RE.test(normalized)) c += 0.1
  if (evidenceCount >= 2) c += 0.05
  if (sourceCount >= 2) c += 0.05
  return Math.min(0.95, Math.round(c * 100) / 100)
}

export const NOISE_TYPES: ReadonlySet<CandidateType> = new Set([
  'generic_term',
  'region_name',
  'page_or_service',
  'unknown',
])
export const SEARCH_ELIGIBLE_TYPES: ReadonlySet<CandidateType> = new Set([
  'parking_lot_name',
  'facility_name',
])
