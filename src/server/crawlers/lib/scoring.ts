/**
 * 관련도 채점 공통 유틸 (Workers 환경 호환)
 */

/** 주소에서 구/동 추출 */
export function extractRegion(address: string): string {
  const parts = address.split(/\s+/)
  const regionParts: string[] = []

  for (const part of parts) {
    if (
      /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/.test(
        part,
      )
    )
      continue
    if (/시$/.test(part) && !/(구$|군$)/.test(part)) continue
    if (/(구|군|동|읍|면|로|길)$/.test(part)) {
      regionParts.push(part)
      if (regionParts.length >= 2) break
    }
  }

  return regionParts.join(' ')
}

/** 제네릭 주차장 이름 감지 */
const GENERIC_PATTERNS = [
  /^제?\d+주차장$/,
  /^지하주차장$/,
  /^주차장$/,
  /^옥상주차장$/,
  /^야외주차장$/,
  /^주차타워$/,
  /^기계식주차장$/,
  /^자주식주차장$/,
  /^공영주차장$/,
  /^\S{1,2}주차장$/,
]

export function isGenericName(name: string): boolean {
  const cleaned = name.replace(/\s/g, '')
  return GENERIC_PATTERNS.some((p) => p.test(cleaned))
}

/** HTML 태그 및 엔티티 제거 */
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
  const data = new TextEncoder().encode(url)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

/**
 * 부동산/광고/무관 콘텐츠 노이즈 패턴
 * (validate-ad-filter.ts AD_PATTERNS 기반 + 추가 확장)
 */
const NOISE_PATTERNS = [
  // 부동산/분양
  /모델하우스/,
  /분양가/,
  /분양정보/,
  /분양조건/,
  /잔여세대/,
  /견본주택/,
  /입주자모집/,
  /입주예정/,
  /공급조건/,
  /시행사/,
  /시공사/,
  /투자수익/,
  /프리미엄분양/,
  /빌라\s*매매/,
  /아파트\s*매매/,
  /매물/,
  /전세\s*모/,
  /월세\s*모/,
  /원룸\s*\d/,
  /투룸/,
  /쓰리룸/,
  /상가\s*임대/,
  /사무실\s*임대/,
  /오피스텔\s*임대/,
  /신축빌라/,
  /신축원룸/,
  /경매물건/,
  /임장\s*(기록|후기|보고)/,
  /지구\s*임장/,
  /청약/,
  /재개발/,
  /재건축/,
  // 광고/홍보
  /체험단.*모집/,
  /업체\s*추천\s*(깔끔|꼼꼼)/,
  /메디컬빌딩/,
  // 무관 콘텐츠
  /살인사건/,
  /뮤지컬\s*(렌트|위키드|캣츠)/,
  /커튼콜/,
  /추경예산/,
  /예산\s*편성/,
  /청소.*업체/,
  /이사.*업체/,
  /인테리어.*업체/,
  /다이어트/,
  /성형/,
  /피부과/,
  /치과/,
]

/** 카테고리성 제네릭 단어 — 주차장 유형/속성을 나타내지만 특정 장소를 식별하지 않음 */
const GENERIC_KEYWORDS = new Set([
  '공영',
  '민영',
  '노상',
  '노외',
  '무료',
  '유료',
  '부설',
  '임시',
  '제1',
  '제2',
  '제3',
  '제4',
  '제5',
  '주변',
  '인근',
  '마을공동',
  '마을',
])

/** 지역명 접미사 — 행정구역을 나타내는 단어 */
function isLocationWord(word: string): boolean {
  return /[시군구동읍면리]$/.test(word)
}

/**
 * 주차장 이름에 고유 식별자가 있는지 판별한다.
 * generic/location을 모두 제거한 뒤 의미 있는 잔여가 있으면 true.
 */
export function hasSpecificIdentifier(parkingName: string): boolean {
  let cleaned = parkingName
    .toLowerCase()
    .replace(NAME_SUFFIX, '')
    .replace(/주차$/, '') // "노상공영주차" → "노상공영"
    .trim()

  // 제네릭 키워드 제거
  for (const gk of GENERIC_KEYWORDS) {
    cleaned = cleaned.replaceAll(gk, '')
  }

  // 지역명 제거: 독립 단어로 시/군/구/동/읍/면/리로 끝나는 것만 (띄어쓰기 기준)
  cleaned = cleaned
    .split(/\s+/)
    .filter((w) => !isLocationWord(w))
    .join('')
    .trim()

  return cleaned.length >= 2
}

/**
 * 주소에서 시/군 이름을 추출한다 (시/군 레벨 지역 검증용).
 * "경상북도 경주시 중앙로 47번길 13" → "경주"
 * "서울특별시 강남구 역삼동" → "" (광역시는 구 레벨이므로 빈 문자열)
 */
export function extractCity(address: string): string {
  const match = address.match(/\s(\S+?)(시|군)\s/)
  if (!match) return ''
  if (/특별|광역/.test(match[1])) return ''
  return match[1]
}

/**
 * 주차장명에서 매칭용 키워드를 추출한다.
 * generic 키워드는 제거하여 오매칭을 방지한다.
 */
/** 주차장명 접미사 패턴 */
const NAME_SUFFIX = /(?:공영|민영|노외|노상|부설|유료|무료|임시|기계식)?주차장\d*$/

export function extractNameKeywords(parkingName: string): string[] {
  const nameLower = parkingName.toLowerCase()
  const keywords: string[] = []

  // 1. 전체 이름 (접미사 제거)
  const fullName = nameLower.replace(NAME_SUFFIX, '').trim()
  if (fullName.length >= 2) keywords.push(fullName)

  // 2. 단어 분리 (띄어쓰기 기준)
  const words = nameLower
    .replace(NAME_SUFFIX, '')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
  keywords.push(...words)

  // 3. 원본 이름 (정확 매칭용)
  if (nameLower.length >= 3) keywords.push(nameLower)

  // 4. 붙어있는 이름에서 동/읍/면/리/구 기준 앞부분 추출
  const locMatch = fullName.match(/^(.+?[동읍면리구])/)
  if (locMatch && locMatch[1].length >= 2) keywords.push(locMatch[1])

  // 5. 붙어있는 복합 이름 분리 (띄어쓰기 없는 한글+한글 경계)
  //    "마장축산물시장서문" → "마장축산물시장", "서문"
  //    "고운들공영" → "고운들"
  //    "KTX환승" → "ktx", "환승"
  const withoutSuffix = fullName.replace(/\s/g, '')
  if (withoutSuffix.length >= 4) {
    // 공영/민영/유료/무료 등 접두사도 분리
    const prefixMatch = withoutSuffix.match(/^(.+?)(공영|민영|유료|무료|노상|노외)$/)
    if (prefixMatch && prefixMatch[1].length >= 2) {
      keywords.push(prefixMatch[1])
    }
    // 시장/역/대학/병원 등 시설명 경계로 분리
    const facilityMatch = withoutSuffix.match(
      /^(.+?(?:시장|역|대학|병원|공원|센터|회관|마을|아파트))(.*)/,
    )
    if (facilityMatch && facilityMatch[1].length >= 2) {
      keywords.push(facilityMatch[1])
    }
    // 영문+한글 경계 분리: "KTX환승" → "ktx"
    const engMatch = withoutSuffix.match(/^([a-z]+)/i)
    if (engMatch && engMatch[1].length >= 2) {
      keywords.push(engMatch[1].toLowerCase())
    }
  }

  // 6. 중복 제거 + 제네릭 키워드 필터링
  return [...new Set(keywords)].filter((kw) => !GENERIC_KEYWORDS.has(kw))
}

/**
 * 주소에서 시/도 레벨을 추출한다 (광역 지역 검증용).
 * "서울특별시 강남구 ..." → "서울"
 * "경기도 수원시 ..." → "경기"
 */
export function extractProvince(address: string): string {
  const match = address.match(
    /^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/,
  )
  return match ? match[1] : ''
}

export type MatchConfidence = 'high' | 'medium' | 'none'

/** 네이버 블로그 검색 결과 관련도 점수 (0-100) */
export function scoreBlogRelevance(
  title: string,
  description: string,
  parkingName: string,
  address: string,
): number {
  const titleLower = stripHtml(title).toLowerCase()
  const descLower = stripHtml(description).toLowerCase()
  const combined = `${titleLower} ${descLower}`

  // 주차 관련 키워드가 없으면 0점 (게이트)
  if (!combined.includes('주차') && !combined.includes('parking')) {
    return 0
  }

  // 노이즈 필터링
  if (NOISE_PATTERNS.some((p) => p.test(combined))) {
    return 0
  }

  let score = 0
  let nameMatched = false

  const nameKeywords = extractNameKeywords(parkingName)
  const hasSpecific = hasSpecificIdentifier(parkingName)

  // 지역 매칭 (먼저 계산 — 아래 분기에서 사용)
  const region = extractRegion(address).toLowerCase()
  const regionWords = region.split(/\s+/).filter((w) => w.length >= 2)
  const regionMatched = regionWords.some((rw) => titleLower.includes(rw) || descLower.includes(rw))

  // 시/군 레벨 지역 매칭 (specific 없는 경우 보강)
  const city = extractCity(address)
  const cityMatched = city ? combined.includes(city) : false
  const locationMatched = regionMatched || cityMatched

  if (regionMatched) score += 20

  // 이름 매칭 (전략 분기)
  const nameInTitle = nameKeywords.some((kw) => titleLower.includes(kw))
  const nameInDesc = nameKeywords.some((kw) => descLower.includes(kw))

  if (hasSpecific) {
    // A. 고유 식별자 있음 → 이름 매칭만으로 점수 부여
    if (nameInTitle) {
      score += 40
      nameMatched = true
    }
    if (nameInDesc) {
      score += 20
      nameMatched = true
    }
  } else {
    // B. 고유 식별자 없음 → 이름 + 지역 동시 매칭 필요 (복합 키)
    if ((nameInTitle || nameInDesc) && locationMatched) {
      if (nameInTitle) score += 40
      if (nameInDesc) score += 20
      nameMatched = true
    }
  }

  // 주차 키워드 보너스
  if (titleLower.includes('주차') || descLower.includes('주차')) score += 20

  // ── 보정 규칙 ──

  // 이름 매칭 없이는 최대 40점 (지역+주차만으로는 threshold 못 넘김)
  if (!nameMatched) {
    score = Math.min(score, 40)
  }

  // 이름 매칭됐지만 광역 지역 불일치 → 동명이인 감점
  if (nameMatched && regionMatched === false) {
    const province = extractProvince(address)
    if (province && !combined.includes(province)) {
      score = Math.max(0, score - 30)
    }
  }

  return Math.min(100, score)
}

/**
 * 매칭 신뢰도를 판정한다.
 *
 * - high: 주차장 전체 이름(접미사 제거)이 글에 그대로 등장 + "주차" 키워드
 *         → 바로 저장 (AI 불필요)
 * - medium: 부분 키워드 매칭, 지역명 매칭 등 score≥40
 *         → AI 검증 필요
 * - none: score<40 또는 게이트 미통과
 *         → 스킵
 */
export function getMatchConfidence(
  title: string,
  description: string,
  parkingName: string,
  address: string,
): { score: number; confidence: MatchConfidence } {
  const score = scoreBlogRelevance(title, description, parkingName, address)
  if (score < 40) return { score, confidence: 'none' }

  const combined = `${stripHtml(title)} ${stripHtml(description)}`.toLowerCase()
  const nameKeywords = extractNameKeywords(parkingName)

  const matchedKws = nameKeywords.filter((kw) => combined.includes(kw))
  const maxMatchLen = matchedKws.reduce((max, kw) => Math.max(max, kw.length), 0)
  const hasParkingKw = combined.includes('주차') || combined.includes('parking')

  if (maxMatchLen >= 6 && hasParkingKw) {
    // 고유 식별자 없으면 high 불가 — AI 검증 필수
    if (!hasSpecificIdentifier(parkingName)) {
      return { score, confidence: 'medium' }
    }

    const bestKw = matchedKws.reduce((best, kw) => (kw.length > best.length ? kw : best), '')

    // 도로명(~로, ~길, ~번길)만 매칭된 경우 → medium (주소에 흔히 포함)
    if (/^.+(로|길|번길)$/.test(bestKw) && !/주차/.test(bestKw)) {
      return { score, confidence: 'medium' }
    }

    // 일반 시설명(행정복지센터, 어린이공원 등)만 매칭된 경우 → medium (동명이인)
    const genericFacility =
      /^(행정복지센터|어린이공원|종합시장|전통시장|버스터미널|시외버스터미널|체육관|문화센터|보건소|주민센터|파출소|우체국)$/
    if (genericFacility.test(bestKw)) {
      return { score, confidence: 'medium' }
    }

    // 주차장명에 "주변/옆/앞/인근"이 포함 → 시설명만 매칭은 medium
    if (
      /[주변옆앞인근]/.test(parkingName) &&
      !combined.includes(parkingName.toLowerCase().replace(NAME_SUFFIX, '').trim())
    ) {
      return { score, confidence: 'medium' }
    }

    return { score, confidence: 'high' }
  }

  return { score, confidence: 'medium' }
}

/** YouTube 댓글 관련도 점수 (0-100) */
export function scoreYoutubeComment(text: string, parkingName: string): number {
  let score = 0
  const t = text.toLowerCase()

  const parkingKw = ['주차', 'parking', '차', '운전']
  const difficultyKw = [
    '좁',
    '무서',
    '힘들',
    '긁',
    '어려',
    '공포',
    '골뱅이',
    '나선',
    '경사',
    '회전',
    '기둥',
  ]
  const positiveKw = ['넓', '쉬', '편', '여유', '추천']

  if (parkingKw.some((kw) => t.includes(kw))) score += 30
  if (difficultyKw.some((kw) => t.includes(kw))) score += 40
  if (positiveKw.some((kw) => t.includes(kw))) score += 20

  const nameWords = parkingName
    .replace(/주차장|주차/g, '')
    .split(/\s+/)
    .filter((w) => w.length >= 2)
  if (nameWords.some((kw) => t.includes(kw.toLowerCase()))) score += 20

  if (text.length < 10) score -= 20

  return Math.max(0, Math.min(100, score))
}
