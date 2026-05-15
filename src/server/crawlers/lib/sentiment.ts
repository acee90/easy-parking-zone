/**
 * 주차장 텍스트 감성 분석 모듈 (Workers 환경 호환)
 *
 * 알고리즘 문서: docs/parking-scoring-algorithm.md §4.3
 *
 * Pipeline: 텍스트 → 관련도 게이트 → 부정어 처리 → IDF 가중 감성 → 스케일 변환
 */

// ---------------------------------------------------------------------------
// 1. 키워드 사전
// ---------------------------------------------------------------------------

/** 긍정 키워드 — 주차하기 쉬움을 나타내는 표현 (주요 활용형 포함)
 *
 * 노이즈 제거:
 * - '추천' — Naver 블로그/디렉터리 UI(추천수, [추천](url), 카테고리) 다수
 * - '한산' — 북한산/남한산/한산도 지역명 false positive
 */
export const POSITIVE_KEYWORDS = [
  '넓',
  '널널',
  '편하',
  '편해',
  '편한',
  '편리',
  '여유',
  '쉽',
  '쉬운',
  '쉬워',
  '쉬웠',
  '초보',
  '평면',
  '자주식',
  '잘되어',
  '넉넉',
  '깔끔',
  '쾌적',
  '공간이 넓',
  '자리가 많',
  '주차면이 넓',
  // 주관 평가 — 좋았다/만족/수월
  '좋았',
  '좋아요',
  '만족',
  '수월',
] as const

/** 부정 키워드 — 주차하기 어려움을 나타내는 표현 (주요 활용형 포함)
 *
 * 노이즈 제거:
 * - '사고' — 사고방식/사고력/사고관 일반어
 * - '회전' — 좌회전/우회전/회전식 false positive
 * - '대기' — 대기실/대기업/대기오염 false positive
 */
export const NEGATIVE_KEYWORDS = [
  '좁',
  '힘들',
  '힘든',
  '무서',
  '무섭',
  '긁',
  '어려',
  '어렵',
  '어려웠',
  '공포',
  '골뱅이',
  '나선',
  // '기계식' 제거 — structural prior(PRIOR_MECHANICAL)가 이미 반영, 이중 계산 방지
  '기둥',
  '사이드미러',
  '복잡',
  '급경사',
  '만차',
  '헬',
  'hell',
  '지옥',
  '빡빡',
  '빡시',
  '빡세',
  '위험',
  '찌그러',
  '찍힌',
  '경사',
  '돌아가',
  // 주관 평가 — 안좋았다/불편/후회
  '불편',
  '안좋',
  '후회',
] as const

/**
 * 키워드별 substring false positive 차단.
 * - prev: 키워드 직전 1글자가 매칭되면 제외 (예: 쉽 ← 아쉽)
 * - next: 키워드 직후 시작 문자열이 매칭되면 제외 (예: 헬 → 헬기)
 */
const KEYWORD_EXCLUSIONS: Record<string, { prev?: readonly string[]; next?: readonly string[] }> = {
  // 아쉽다(regret)는 부정 어휘이지만 '쉽'으로 잡으면 polarity 반전 사고
  쉽: { prev: ['아'] },
  쉬운: { prev: ['아'] },
  쉬워: { prev: ['아'] },
  쉬웠: { prev: ['아'] },
  // 세무서/법무서/재무서
  무서: { prev: ['세', '법', '재'] },
  무섭: { prev: ['세', '법', '재'] },
  // 헬기장/헬스장/헬리포트/헬멧/헬로윈/헬메스 등
  헬: { next: ['기', '스', '리', '멧', '로', '메'] },
  // 경사로움/경사스러우 (긍정 의미 — '경사스럽다')
  경사: { next: ['로움', '롭', '스러'] },
}

/** 부정어 패턴 — 뒤따르는 키워드의 극성 반전 */
export const NEGATION_PATTERNS = [
  '안',
  '않',
  '못',
  '없',
  '아닌',
  '별로',
  '안되',
  '않은',
  '않는',
  '못하',
] as const

/** 이모티콘/신조어 — 부정 신호 */
export const EMOTICON_NEGATIVE = ['ㅠㅠ', 'ㅜㅜ', 'ㅠ', 'ㅜ', 'ㅎㄷㄷ', '후덜덜', 'ㄷㄷ'] as const

/** 이모티콘/신조어 — 긍정 신호 */
export const EMOTICON_POSITIVE = ['👍', '꿀팁', '강추', 'ㄱㅊ', '괜찮'] as const

/** 강조어 — 인접 키워드 가중치 1.5배 */
export const INTENSIFIERS = [
  'ㄹㅇ',
  'ㅈㄴ',
  '진심',
  '진짜',
  '개',
  '존나',
  '너무',
  '엄청',
  '매우',
  '완전',
  '정말',
] as const

// ---------------------------------------------------------------------------
// 2. 관련도 게이트 (Relevance Gate)
// ---------------------------------------------------------------------------

/** 주차 경험 키워드 (관련도 판별용, 긍정+부정 통합) */
const EXPERIENCE_KEYWORDS = [
  // 부정 경험
  '좁',
  '힘들',
  '무서',
  '긁',
  '어려',
  '공포',
  '골뱅이',
  '나선',
  '기계식',
  '기둥',
  '사이드미러',
  '복잡',
  '급경사',
  '만차',
  '대기',
  '헬',
  'hell',
  '지옥',
  '빡빡',
  '빡시',
  '빡세',
  '회전',
  '경사',
  // 긍정 경험 (주차 맥락 없이 단독 매칭될 수 있는 "추천" 등은 제외)
  '넓',
  '널널',
  '편하',
  '편리',
  '여유',
  '쉽',
  '초보',
  '평면',
  '자주식',
  '넉넉',
  '한산',
  // 구체적 주차 경험 서술
  '주차면',
  '주차장 입구',
  '진입',
  '출차',
  '주차 공간',
  '주차하기',
  '차폭',
  '주차타워',
  '발렛',
  // 주관 평가 — 좋았다/불편/만족/수월/후회
  '좋았',
  '불편',
  '만족',
  '수월',
  '안좋',
  '후회',
  '어려웠',
  '쉬웠',
] as const

/**
 * 텍스트의 주차 관련도 점수를 계산한다 (0.0 ~ 1.0).
 * 알고리즘 문서 §4.3 Step 1.
 *
 * - 주차 경험 키워드 2개 이상 → 1.0
 * - 주차 경험 키워드 1개 → 0.7
 * - "주차" 단어만 포함 → 0.3
 * - 주차 관련 키워드 없음 → 0.0
 */
export function computeRelevance(rawText: string): number {
  const t = stripBoilerplate(rawText).toLowerCase()

  const matchCount = EXPERIENCE_KEYWORDS.filter((kw) => t.includes(kw.toLowerCase())).length

  if (matchCount >= 2) return 1.0
  if (matchCount === 1) return 0.7
  if (t.includes('주차')) return 0.3
  return 0.0
}

// ---------------------------------------------------------------------------
// 3. 토큰화 및 부정어 처리
// ---------------------------------------------------------------------------

interface Token {
  text: string
  index: number
  /** 원본 텍스트에서 토큰 시작 문자 위치 (주차 근접 필터용) */
  charStart: number
}

/** 간단한 한국어 토큰화 (공백 + 조사 분리, 문자 위치 추적) */
function tokenize(text: string): Token[] {
  const tokens: Token[] = []
  const sep = /[\s,.!?;:…·~]+/g
  let pos = 0
  let idx = 0
  let m: RegExpExecArray | null
  while ((m = sep.exec(text)) !== null) {
    if (m.index > pos) {
      const part = text.slice(pos, m.index)
      if (part.length > 0) tokens.push({ text: part, index: idx++, charStart: pos })
    }
    pos = m.index + m[0].length
  }
  if (pos < text.length) {
    const part = text.slice(pos)
    if (part.length > 0) tokens.push({ text: part, index: idx++, charStart: pos })
  }
  return tokens
}

/** 키워드가 '주차' 키워드와 ±PARKING_PROXIMITY자 내에 있는지 확인. */
const PARKING_PROXIMITY = 50
function isNearParking(text: string, charPos: number): boolean {
  const start = Math.max(0, charPos - PARKING_PROXIMITY)
  const end = Math.min(text.length, charPos + PARKING_PROXIMITY)
  return text.slice(start, end).includes('주차')
}

/**
 * 정보 페이지/안내문 시그니처 감지 → 감성 신호를 3.0 쪽으로 추가 damping.
 * 사용자 후기처럼 키워드는 들어 있으나 글 자체는 광고/정보 안내인 경우.
 *
 * 시그니처:
 *   - 마크다운 표(`|---|`)
 *   - Q&A 패턴 (자주 묻는 질문, Q1., Q2.)
 *   - 정형 메타데이터 키 (운영시간, 주차구획수, 관리기관 등)
 *   - 가이드 톤 (총정리, 이용 방법, 영업시간) + 정형 리스트(* 위치/주소/요금)
 *
 * 반환: 1.0(아님) / 0.7(약한 신호) / 0.4(강한 신호)
 */
function infoPageDamper(text: string): number {
  let signals = 0
  if (/\|\s*---\s*\|/.test(text)) signals++
  if (/자주\s*묻는|Q1\.|Q2\./i.test(text)) signals++
  if (/(운영시간|운영\s*요일|주차구획수|관리기관|월정기권)/.test(text)) signals++
  if (
    /(총정리|이용\s*방법|영업시간|주차비)/.test(text) &&
    /(\*\s+\*\*?\s*위치|\*\s+\*\*?\s*주소|\*\s+\*\*?\s*요금|\*\s+\*\*?\s*전화)/.test(text)
  )
    signals++
  if (signals >= 2) return 0.25
  if (signals >= 1) return 0.55
  return 1.0
}

/**
 * 마크다운 링크/이미지/URL 등 boilerplate를 공백으로 치환.
 * Naver 블로그/디렉터리 사이트의 UI 텍스트가 false positive를 유발하는 것을 막는다.
 */
function stripBoilerplate(text: string): string {
  return text
    .replace(/!?\[[^\]\n]*\]\([^)\n]*\)/g, ' ') // [text](url), ![alt](url)
    .replace(/https?:\/\/\S+/g, ' ') // raw URL
}

/**
 * 토큰 내에서 키워드가 매칭되는지 확인 (KEYWORD_EXCLUSIONS 적용).
 */
function matchesKeyword(tokenText: string, kw: string): boolean {
  const lower = tokenText.toLowerCase()
  const target = kw.toLowerCase()
  const idx = lower.indexOf(target)
  if (idx === -1) return false
  const excl = KEYWORD_EXCLUSIONS[kw]
  if (!excl) return true
  if (excl.prev && idx > 0) {
    const prev = lower[idx - 1]
    if (excl.prev.includes(prev)) return false
  }
  if (excl.next) {
    const afterIdx = idx + target.length
    if (afterIdx < lower.length) {
      const after = lower.slice(afterIdx, afterIdx + 4)
      if (excl.next.some((n) => after.startsWith(n.toLowerCase()))) return false
    }
  }
  return true
}

/** 토큰이 감성 키워드를 포함하는지 확인 */
function containsSentimentKeyword(tokenText: string): boolean {
  return (
    POSITIVE_KEYWORDS.some((kw) => matchesKeyword(tokenText, kw)) ||
    NEGATIVE_KEYWORDS.some((kw) => matchesKeyword(tokenText, kw))
  )
}

/**
 * 부정어 ± 2어절 이내 키워드 → 극성 반전 감지.
 * "안 좁다" (부정어→키워드) + "넓지 않아서" (키워드→부정어) 모두 처리.
 * "넓지 않아서 힘들었어요" → "넓"만 반전, "힘들"은 유지 (앞에 키워드가 있으면 뒤 반전 억제)
 * 반환값: 부정어에 의해 반전되어야 하는 토큰 인덱스 Set
 */
function isNegationToken(tokenText: string): boolean {
  // 안/못: 단독 토큰("안 좁다", "못 가다") 또는 조사 1글자만 — "안전/안내/못지않" false negation 방지
  if (tokenText === '안' || tokenText === '못') return true
  if (
    tokenText.length === 2 &&
    (tokenText[0] === '안' || tokenText[0] === '못') &&
    /[은는도이가만]/.test(tokenText[1])
  )
    return true
  // 않/없: 활용형 prefix 매칭 (토큰 길이 ≤ 4)
  if (tokenText.length <= 4 && (tokenText.startsWith('않') || tokenText.startsWith('없')))
    return true
  // 아니: "아니어서/아니라/아니라서/아니다" 활용 — 토큰 시작이 '아니'이고 짧을 때만
  // ("아니지만/아니어서" 등은 인정, "아니라고는/아니마저" 같은 긴 케이스는 false negation 위험으로 제외)
  if (tokenText.length <= 6 && tokenText.startsWith('아니')) return true
  // 다음 명시 패턴은 토큰에 포함되면 negation
  const fullPatterns = ['아닌', '별로', '안되', '안된', '안돼', '못하', '못해', '못한']
  for (const np of fullPatterns) if (tokenText.includes(np)) return true
  return false
}

function findNegatedIndices(tokens: Token[]): Set<number> {
  const negated = new Set<number>()
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].text
    const isNegation = isNegationToken(t)
    if (!isNegation) continue

    // 앞 2어절에서 키워드가 있는지 확인
    let hasBackwardKeyword = false
    for (let j = Math.max(0, i - 2); j < i; j++) {
      if (containsSentimentKeyword(tokens[j].text)) {
        negated.add(j)
        hasBackwardKeyword = true
      }
    }

    // 앞에 키워드가 없을 때만 뒤 2어절 반전 (e.g. "안 좁다")
    if (!hasBackwardKeyword) {
      for (let j = i + 1; j <= Math.min(i + 2, tokens.length - 1); j++) {
        negated.add(j)
      }
    }
  }
  return negated
}

/**
 * 강조어 인접 토큰 감지.
 * 반환값: 강조 적용 대상 토큰 인덱스 Set
 */
function findIntensifiedIndices(tokens: Token[]): Set<number> {
  const intensified = new Set<number>()
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].text
    if (INTENSIFIERS.some((intens) => t.includes(intens))) {
      // 뒤 1어절에 강조 적용
      if (i + 1 < tokens.length) {
        intensified.add(i + 1)
      }
    }
  }
  return intensified
}

// ---------------------------------------------------------------------------
// 4. IDF 가중 감성 점수 계산
// ---------------------------------------------------------------------------

/** IDF 사전 타입 (keyword → idf value) */
export type IdfDict = Record<string, number>

/** 기본 IDF 값 (사전에 없는 키워드) */
const DEFAULT_IDF = 0.5

function getIdf(keyword: string, idfDict: IdfDict | null): number {
  if (!idfDict) return DEFAULT_IDF
  return idfDict[keyword] ?? DEFAULT_IDF
}

interface KeywordMatch {
  keyword: string
  polarity: 1 | -1
  idf: number
  intensified: boolean
}

/**
 * 텍스트에서 키워드를 매칭하고 극성/IDF/부정어/강조를 적용한 결과를 반환한다.
 */
function extractKeywordMatches(text: string, idfDict: IdfDict | null): KeywordMatch[] {
  const tokens = tokenize(text)
  const negatedIndices = findNegatedIndices(tokens)
  const intensifiedIndices = findIntensifiedIndices(tokens)
  const matches: KeywordMatch[] = []

  for (let i = 0; i < tokens.length; i++) {
    const tokenText = tokens[i].text

    // 주차 맥락 근접 필터 — 토큰이 '주차'와 ±80자 내가 아니면 키워드 매칭 자체를 스킵.
    // (식당/카페 리뷰 본문의 일반 긍정/부정 키워드가 점수에 섞이는 것을 방지)
    if (!isNearParking(text, tokens[i].charStart)) continue

    for (const kw of POSITIVE_KEYWORDS) {
      if (matchesKeyword(tokenText, kw)) {
        const basePolarity = 1
        const polarity = negatedIndices.has(i) ? (-basePolarity as 1 | -1) : basePolarity
        matches.push({
          keyword: kw,
          polarity,
          idf: getIdf(kw, idfDict),
          intensified: intensifiedIndices.has(i),
        })
        break // 토큰당 최대 1개 긍정 키워드
      }
    }

    for (const kw of NEGATIVE_KEYWORDS) {
      if (matchesKeyword(tokenText, kw)) {
        const basePolarity = -1
        const polarity = negatedIndices.has(i) ? (-basePolarity as 1 | -1) : basePolarity
        matches.push({
          keyword: kw,
          polarity,
          idf: getIdf(kw, idfDict),
          intensified: intensifiedIndices.has(i),
        })
        break // 토큰당 최대 1개 부정 키워드
      }
    }
  }

  return matches
}

/**
 * 이모티콘/신조어에서 추가 감성 신호를 추출한다.
 */
function extractEmoticonSignals(text: string): { positive: number; negative: number } {
  let positive = 0
  let negative = 0

  for (const em of EMOTICON_NEGATIVE) {
    if (text.includes(em)) negative++
  }
  for (const em of EMOTICON_POSITIVE) {
    if (text.includes(em)) positive++
  }

  return { positive, negative }
}

// ---------------------------------------------------------------------------
// 5. 감성 점수 산출 (공개 API)
// ---------------------------------------------------------------------------

export interface SentimentResult {
  /** 관련도 점수 0.0 ~ 1.0 */
  relevance: number
  /** 원시 감성 점수 -1.0 ~ +1.0 (IDF 가중) */
  sentimentRaw: number
  /** 1-5 스케일 변환 점수 (부정성 편향 보정 적용) */
  sentimentScore: number
  /** 매칭된 키워드 수 */
  matchCount: number
}

/**
 * 텍스트의 감성을 분석하여 SentimentResult를 반환한다.
 *
 * @param text - 분석할 텍스트 (블로그 본문, 댓글 등)
 * @param idfDict - IDF 사전 (null이면 기본 가중치 사용)
 */
export function analyzeSentiment(rawText: string, idfDict: IdfDict | null = null): SentimentResult {
  const text = stripBoilerplate(rawText)
  const relevance = computeRelevance(text)

  // 관련도 0이면 감성 분석 불필요
  if (relevance === 0) {
    return { relevance: 0, sentimentRaw: 0, sentimentScore: 3.0, matchCount: 0 }
  }

  const matches = extractKeywordMatches(text, idfDict)
  const emoticons = extractEmoticonSignals(text)

  // 이모티콘 신호를 키워드 매치에 추가 (IDF 0.3 고정)
  const EMOTICON_IDF = 0.3
  for (let i = 0; i < emoticons.positive; i++) {
    matches.push({ keyword: 'emoticon+', polarity: 1, idf: EMOTICON_IDF, intensified: false })
  }
  for (let i = 0; i < emoticons.negative; i++) {
    matches.push({ keyword: 'emoticon-', polarity: -1, idf: EMOTICON_IDF, intensified: false })
  }

  if (matches.length === 0) {
    // 주차 키워드는 있지만 감성 키워드 없음 → 중립
    return { relevance, sentimentRaw: 0, sentimentScore: 3.0, matchCount: 0 }
  }

  // IDF 가중 감성 계산: Σ(polarity × idf × intensifier) / Σ(idf × intensifier)
  let weightedSum = 0
  let weightSum = 0

  for (const m of matches) {
    const w = m.idf * (m.intensified ? 1.5 : 1.0)
    weightedSum += m.polarity * w
    weightSum += w
  }

  const sentimentRaw = weightSum > 0 ? weightedSum / weightSum : 0

  // 1-5 스케일 변환: S = sentimentRaw × 2.0 + 3.0
  // (이전 -0.1 보정 제거 — 실측 분포가 positive 편향으로 보정 방향이 반대였음)
  const scaled = sentimentRaw * 2.0 + 3.0

  // 키워드 수 기반 감쇠: 키워드가 적으면 중립(3.0) 방향으로 당김.
  // matches=1~2는 false positive 위험 높음 — 강한 감쇠.
  // matches=3~4는 신뢰도 중간, matches=5+는 거의 그대로.
  const DAMPING: Record<number, number> = { 1: 0.4, 2: 0.55, 3: 0.75, 4: 0.9 }
  const damping = DAMPING[matches.length] ?? 1.0
  // 정보 페이지/안내문에서 광고성 키워드 매칭 위험 완화
  const infoDamp = infoPageDamper(text)
  const damped = 3.0 + (scaled - 3.0) * damping * infoDamp
  const sentimentScore = Math.max(1.0, Math.min(5.0, damped))

  return {
    relevance,
    sentimentRaw: Math.round(sentimentRaw * 1000) / 1000,
    sentimentScore: Math.round(sentimentScore * 100) / 100,
    matchCount: matches.length,
  }
}

// ---------------------------------------------------------------------------
// 6. 시간 감쇠
// ---------------------------------------------------------------------------

const HALF_LIFE_DAYS = 365

/**
 * 시간 감쇠 가중치를 계산한다.
 * d(t) = 0.5^(경과일수 / 365)
 *
 * @param publishedAt - ISO date string (e.g. "2024-06-15")
 * @param now - 기준 날짜 (기본: 오늘)
 */
export function timeDecay(publishedAt: string | null, now?: Date): number {
  if (!publishedAt) return 0.5 // 날짜 없으면 1년 전으로 간주

  const published = new Date(publishedAt)
  const reference = now ?? new Date()
  const daysDiff = (reference.getTime() - published.getTime()) / (1000 * 60 * 60 * 24)

  if (daysDiff < 0) return 1.0 // 미래 날짜 → 최신으로 처리
  return 0.5 ** (daysDiff / HALF_LIFE_DAYS)
}

// ---------------------------------------------------------------------------
// 7. 배치용 유틸: 주차장별 텍스트 감성 집계
// ---------------------------------------------------------------------------

export interface TextEntry {
  text: string
  publishedAt: string | null
}

/**
 * 여러 텍스트 항목의 감성을 집계하여 주차장의 텍스트 기반 점수를 반환한다.
 * 알고리즘 문서 §4.3 Step 5.
 *
 * S_text = Σ(R_j × d_j × s_j) / Σ(R_j × d_j)
 *
 * @returns 1-5 스케일 점수 (관련도 높은 텍스트가 없으면 null)
 */
export function aggregateTextSentiment(
  entries: TextEntry[],
  idfDict: IdfDict | null = null,
  now?: Date,
): { score: number; count: number; effectiveCount: number } | null {
  let weightedSum = 0
  let weightSum = 0
  let relevantCount = 0

  for (const entry of entries) {
    const result = analyzeSentiment(entry.text, idfDict)

    // 관련도 0.3 이하는 감성 분석에서 완전 제외 (§5.1)
    if (result.relevance <= 0.3) continue

    const decay = timeDecay(entry.publishedAt, now)
    const w = result.relevance * decay

    weightedSum += w * result.sentimentScore
    weightSum += w
    relevantCount++
  }

  if (weightSum === 0 || relevantCount === 0) return null

  const score = Math.round((weightedSum / weightSum) * 100) / 100
  // 유효 데이터량: 관련도 0.7 이상 텍스트만 카운트, 각 ×0.2
  const highRelevanceCount = entries.filter((e) => computeRelevance(e.text) >= 0.7).length
  const effectiveCount = Math.round(highRelevanceCount * 0.2 * 100) / 100

  return {
    score: Math.max(1.0, Math.min(5.0, score)),
    count: relevantCount,
    effectiveCount,
  }
}
