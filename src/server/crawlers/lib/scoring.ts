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
  // 부동산/분양/경매 강화
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
  /경매\s*정보/,
  /사건번호/,
  /법원경매/,
  /감정평가/,
  /최저가/,
  /낙찰/,
  /유찰/,
  /임장\s*(기록|후기|보고)/,
  /지구\s*임장/,
  /청약/,
  /재개발/,
  /재건축/,
  // 광고/홍보
  /체험단.*모집/,
  /업체\s*추천\s*(깔끔|꼼꼼)/,
  /메디컬빌딩/,
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
/**
 * 전국 어디에나 있는 시설명. 이것만 남으면 고유 식별자가 아니다.
 * 목록 출처: 2026-09-04 오매칭 실측 사례 (문화예술회관·평생학습관·국민체육센터·중앙시장 등).
 */
const GENERIC_FACILITIES = [
  '문화예술회관',
  '문화의전당',
  '평생학습관',
  '국민체육센터',
  '생활체육관',
  '체육센터',
  '문화센터',
  '복지관',
  '보건소',
  '도서관',
  '학습관',
  '전통시장',
  '종합시장',
  '상설시장',
  '수산시장',
  '터미널',
  '시청',
  '구청',
  '군청',
  '읍사무소',
  '면사무소',
  '주민센터',
  '행정복지센터',
  '체육관',
  '운동장',
  '시장',
  '회관',
]

/** 시설명 앞에 흔히 붙는 수식어. 지역을 특정하지 못한다. */
const GENERIC_MODIFIERS = ['중앙', '국민', '시민', '평생', '종합', '공설', '중부', '남부', '북부']

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

  // 흔한 시설명과 그 앞에 붙는 흔한 수식어를 함께 제거한다.
  // '중앙시장'·'평생학습관'·'국민체육센터' 는 남는 조각('중앙'·'평생'·'국민')이 2자라
  // 고유 식별자로 통과했고, 그래서 지역 없이 이름만으로 매칭되는 분기 A 로 갔다.
  // 전국에 같은 이름이 있는 시설이므로 지역을 함께 봐야 한다 (분기 B).
  for (const gf of GENERIC_FACILITIES) {
    cleaned = cleaned.replaceAll(gf, '')
  }
  for (const gm of GENERIC_MODIFIERS) {
    cleaned = cleaned.replaceAll(gm, '')
  }

  // '제1'·'2' 같은 서수는 같은 이름이 여러 개라는 뜻이지 고유 식별자가 아니다.
  cleaned = cleaned.replace(/제?\d+/g, '')

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
/**
 * 시·도 정규형. 주소 표기가 섞여 있다 — 실측 상위 형태가
 * '경기도'·'경상북도'·'서울특별시'·'강원특별자치도' 이고 '경북'·'충남' 같은 축약형도 쓰인다.
 * 짧은 형태만 보던 이전 구현은 '경상북도 김천시 …' 에서 빈 문자열을 돌려줬고,
 * 그 탓에 동명이인 감점이 한 번도 발동하지 않았다 (2026-09-04 확인).
 */
const PROVINCE_ALIASES: readonly (readonly [string, readonly string[]])[] = [
  ['서울', ['서울특별시', '서울']],
  ['부산', ['부산광역시', '부산']],
  ['대구', ['대구광역시', '대구']],
  ['인천', ['인천광역시', '인천']],
  // '광주 북구 …' 처럼 축약해 쓴 주소가 있다. 경기 광주시는 '경기도'로 시작하므로 겹치지 않는다.
  ['광주', ['광주광역시', '광주']],
  ['대전', ['대전광역시', '대전']],
  ['울산', ['울산광역시', '울산']],
  ['세종', ['세종특별자치시', '세종']],
  ['경기', ['경기도', '경기']],
  ['강원', ['강원특별자치도', '강원도', '강원']],
  ['충북', ['충청북도', '충북']],
  ['충남', ['충청남도', '충남']],
  ['전북', ['전북특별자치도', '전라북도', '전북']],
  ['전남', ['전라남도', '전남']],
  ['경북', ['경상북도', '경북']],
  ['경남', ['경상남도', '경남']],
  ['제주', ['제주특별자치도', '제주']],
]

export function extractProvince(address: string): string {
  const head = address.trim()
  for (const [canonical, aliases] of PROVINCE_ALIASES) {
    if (aliases.some((a) => head.startsWith(a))) return canonical
  }
  return ''
}

/**
 * 시·군 이름. 2026-09-04 remote D1 의 `parking_lots.address` 26,331건에서 추출했다.
 * 손으로 적지 않은 이유는 누락이 곧 오매칭 통과이기 때문이다.
 */
const CITY_NAMES: readonly string[] = [
  '가평',
  '강릉',
  '강진',
  '강화',
  '거제',
  '거창',
  '경산',
  '경주',
  '계룡',
  '고령',
  '고성',
  '고양',
  '고창',
  '고흥',
  '곡성',
  '공주',
  '과천',
  '광명',
  '광양',
  '광주',
  '괴산',
  '구례',
  '구리',
  '구미',
  '군산',
  '군위',
  '군포',
  '금산',
  '기장',
  '김제',
  '김천',
  '김포',
  '김해',
  '나주',
  '남양주',
  '남원',
  '남해',
  '논산',
  '단양',
  '달성',
  '담양',
  '당진',
  '동두천',
  '동해',
  '목포',
  '무안',
  '무주',
  '문경',
  '밀양',
  '보령',
  '보성',
  '보은',
  '봉화',
  '부안',
  '부여',
  '부천',
  '사천',
  '산청',
  '삼척',
  '상주',
  '서귀포',
  '서산',
  '서천',
  '성남',
  '성주',
  '속초',
  '수원',
  '순창',
  '순천',
  '시흥',
  '신안',
  '아산',
  '안동',
  '안산',
  '안성',
  '안양',
  '양구',
  '양산',
  '양양',
  '양주',
  '양평',
  '여수',
  '여주',
  '연천',
  '영광',
  '영덕',
  '영동',
  '영암',
  '영양',
  '영월',
  '영주',
  '영천',
  '예산',
  '예천',
  '오산',
  '옥천',
  '옹진',
  '완도',
  '완주',
  '용인',
  '울릉',
  '울주',
  '울진',
  '원주',
  '음성',
  '의령',
  '의성',
  '의왕',
  '의정부',
  '이천',
  '익산',
  '인제',
  '임실',
  '장성',
  '장수',
  '장흥',
  '전주',
  '정선',
  '정읍',
  '제주',
  '제천',
  '증평',
  '진도',
  '진안',
  '진주',
  '진천',
  '창녕',
  '창원',
  '천안',
  '철원',
  '청도',
  '청송',
  '청양',
  '청주',
  '춘천',
  '충주',
  '칠곡',
  '태백',
  '태안',
  '통영',
  '파주',
  '평창',
  '평택',
  '포천',
  '포항',
  '하남',
  '하동',
  '함안',
  '함양',
  '함평',
  '합천',
  '해남',
  '홍성',
  '홍천',
  '화성',
  '화순',
  '화천',
  '횡성',
]

/**
 * 지역명이 뒤에 흔한 낱말을 달고 나와도 지역명이 아닌 경우.
 * 왼쪽 경계만으로는 걸러지지 않아 따로 적는다.
 */
const AMBIGUOUS_FOLLOWERS: Readonly<Record<string, RegExp>> = {
  고양: /^이/, // 고양이
  부산: /^물/, // 부산물
  경주: /^마/, // 경주마
  청주: /^(?:집|잔|를|와)/, // 청주(술)
  진주: /^(?:목|귀|반)/, // 진주 목걸이
  상주: /^(?:하|한|해)/, // 상주하다
  성주: /^(?:간|님)/, // 성주간
}

/**
 * 지역명이 낱말로 등장하는지 본다.
 *
 * **왼쪽**이 한글이면 세지 않는다 — '공영주차장' 의 '영주', '중앙로' 의 '앙로'.
 * **오른쪽**은 한글이 붙어도 센다. 블로그 제목이 '부산여행'·'춘천역'·'청양가볼만한곳'
 * 처럼 붙여 쓰는 일이 흔해서, 오른쪽까지 막으면 진짜 충돌을 놓친다 (2026-09-04 실측).
 * 대신 `AMBIGUOUS_FOLLOWERS` 로 '고양이'·'부산물' 같은 알려진 예외만 뺀다.
 */
function mentionsToken(text: string, token: string): boolean {
  if (!token) return false
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![가-힣])${escaped}`, 'g')
  const deny = AMBIGUOUS_FOLLOWERS[token]
  for (const match of text.matchAll(re)) {
    const rest = text.slice((match.index ?? 0) + token.length)
    if (deny?.test(rest)) continue
    return true
  }
  return false
}

/**
 * 글이 **다른 지역** 이야기인지 판정한다.
 *
 * 배경: '중앙시장'(경북 김천) 에 강릉·속초·통영·문경 중앙시장 글이 131건 붙어 있었고,
 * 채점 함수는 김천 글과 강릉 글에 똑같이 60점을 줬다 (2026-09-04 실측).
 *
 * 순서가 중요하다. **주차장 이름을 먼저 지운다** — 그러지 않으면
 * '서울대공원'(경기 과천 소재) 의 '서울' 을 충돌로 세어 맞는 글을 떨어뜨린다.
 * 이름을 지우고 나면 '속초중앙시장' 은 '속초' 만 남아 경계 조건도 만족한다.
 */
export function detectRegionConflict(text: string, parkingName: string, address: string): boolean {
  let rest = stripHtml(text)
  const nameTokens = [parkingName, ...extractNameKeywords(parkingName)].sort(
    (a, b) => b.length - a.length,
  )
  for (const token of nameTokens) {
    if (token.length >= 2) rest = rest.split(token).join(' ')
  }

  const ownCity = extractCity(address)
  if (ownCity && mentionsToken(rest, ownCity)) return false

  const ownProvince = extractProvince(address)
  const ownAliases = PROVINCE_ALIASES.find(([c]) => c === ownProvince)?.[1] ?? []
  if (ownAliases.some((a) => mentionsToken(rest, a))) return false

  if (CITY_NAMES.some((c) => c !== ownCity && mentionsToken(rest, c))) return true
  return PROVINCE_ALIASES.some(
    ([canonical, aliases]) =>
      canonical !== ownProvince && aliases.some((a) => mentionsToken(rest, a)),
  )
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

  // 글이 다른 지역 이야기면 동명이인이다. 40점을 깎아 임계값(40) 아래로 떨어뜨린다.
  // 이전 구현은 `extractProvince` 가 긴 주소 표기를 못 읽어 한 번도 발동하지 않았다.
  if (nameMatched && detectRegionConflict(combined, parkingName, address)) {
    score = Math.max(0, score - 40)
  }

  return Math.min(100, score)
}

/**
 * 풀텍스트 기반 관련도 점수 (#148 Phase C — v2).
 *
 * `scoreBlogRelevance` 와 동일 시그너처지만 두 번째 인자가 `description` 대신 `fullText` 다.
 * snippet 기반 v1 의 한계를 보완:
 *   - lot 이름 등장 빈도 가중치 (1회 vs 3회 vs 10회)
 *   - 본문 길이 정규화 (긴 본문에서 키워드 1회 등장은 가중치 낮춤)
 *   - 풀텍스트 보일러플레이트 패턴 추가
 *   - 주차 키워드 밀도 (한 번 언급 vs 여러 번 언급)
 */
export function scoreBlogRelevanceFull(
  title: string,
  fullText: string,
  parkingName: string,
  address: string,
): number {
  const titleLower = stripHtml(title).toLowerCase()
  const bodyLower = stripHtml(fullText).toLowerCase()
  const combined = `${titleLower} ${bodyLower}`
  const bodyLength = bodyLower.length

  // 게이트: 주차 키워드 없으면 0점
  const parkingMentions = countOccurrences(combined, '주차')
  if (parkingMentions === 0 && !combined.includes('parking')) {
    return 0
  }

  // 노이즈 필터링 (강화: full_text 보일러플레이트)
  if (NOISE_PATTERNS.some((p) => p.test(combined))) {
    return 0
  }
  if (FULLTEXT_BOILERPLATE_PATTERNS.some((p) => p.test(bodyLower))) {
    return 0
  }

  let score = 0
  let nameMatched = false

  const nameKeywords = extractNameKeywords(parkingName)
  const hasSpecific = hasSpecificIdentifier(parkingName)

  // 지역 매칭
  const region = extractRegion(address).toLowerCase()
  const regionWords = region.split(/\s+/).filter((w) => w.length >= 2)
  const regionMatched = regionWords.some((rw) => titleLower.includes(rw) || bodyLower.includes(rw))
  const city = extractCity(address)
  const cityMatched = city ? combined.includes(city) : false
  const locationMatched = regionMatched || cityMatched

  if (regionMatched) score += 20

  // 이름 매칭 — body 등장 빈도 가중치
  const nameInTitle = nameKeywords.some((kw) => titleLower.includes(kw))
  const nameInBody = nameKeywords.some((kw) => bodyLower.includes(kw))
  const nameBodyFreq = nameKeywords.reduce((sum, kw) => sum + countOccurrences(bodyLower, kw), 0)

  if (hasSpecific) {
    if (nameInTitle) {
      score += 40
      nameMatched = true
    }
    if (nameInBody) {
      score += 20
      nameMatched = true
    }
    // 본문 등장 빈도 보너스 (3회 이상 +5, 10회 이상 +10)
    if (nameBodyFreq >= 10) score += 10
    else if (nameBodyFreq >= 3) score += 5
  } else {
    // 고유 식별자 없음 — 이름 + 지역 동시 매칭 필요
    if ((nameInTitle || nameInBody) && locationMatched) {
      if (nameInTitle) score += 40
      if (nameInBody) score += 20
      nameMatched = true
      if (nameBodyFreq >= 5) score += 5
    }
  }

  // 주차 키워드 보너스 (밀도 기반)
  if (parkingMentions >= 5) score += 25
  else if (parkingMentions >= 1) score += 20

  // 보정 — 이름 매칭 없으면 최대 40점
  if (!nameMatched) {
    score = Math.min(score, 40)
  }

  // 글이 다른 지역 이야기면 동명이인이다 (v1 과 같은 규칙).
  if (nameMatched && detectRegionConflict(combined, parkingName, address)) {
    score = Math.max(0, score - 40)
  }

  // 본문 길이 정규화: 너무 길고 키워드 밀도 낮으면 감점
  // (본문 5000자인데 lot 이름 1회만 등장 = 의심)
  if (bodyLength >= 3000 && nameBodyFreq <= 1 && nameMatched) {
    score = Math.max(0, score - 10)
  }

  return Math.min(100, score)
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0
  let count = 0
  let pos = 0
  while ((pos = haystack.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

// 풀텍스트 보일러플레이트 패턴 (#148 추가)
// snippet 에서는 잡히지 않지만 본문에 들어가면 재활용 가치 없는 글
const FULLTEXT_BOILERPLATE_PATTERNS = [
  /이\s*포스팅은\s*쿠팡\s*파트너스/,
  /일정액의\s*수수료를\s*제공받습니다/,
  /본\s*포스팅은.*?원고료/,
  /상기\s*업체로부터.*?제공받아/,
  /Top\s*\d+\s*저렴한.*?주차장/i,
  /주차장\s*위치.*?영업시간.*?주차비\s*총정리/,
]

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
