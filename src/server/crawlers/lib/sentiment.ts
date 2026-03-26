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

/** 긍정 키워드 — 주차하기 쉬움을 나타내는 표현 (주요 활용형 포함) */
export const POSITIVE_KEYWORDS = [
  "넓",
  "널널",
  "편하", "편해", "편한",
  "편리",
  "여유",
  "쉽", "쉬운", "쉬워",
  "초보",
  "추천",
  "평면",
  "자주식",
  "잘되어",
  "넉넉",
  "깔끔",
  "쾌적",
  "한산",
  "공간이 넓",
  "자리가 많",
  "주차면이 넓",
] as const;

/** 부정 키워드 — 주차하기 어려움을 나타내는 표현 (주요 활용형 포함) */
export const NEGATIVE_KEYWORDS = [
  "좁",
  "힘들", "힘든",
  "무서", "무섭",
  "긁",
  "어려", "어렵",
  "공포",
  "골뱅이",
  "나선",
  "기계식",
  "기둥",
  "사이드미러",
  "복잡",
  "급경사",
  "만차",
  "대기",
  "헬",
  "hell",
  "지옥",
  "빡빡",
  "빡시",
  "빡세",
  "위험",
  "사고",
  "찌그러",
  "찍힌",
  "회전",
  "경사",
  "돌아가",
] as const;

/** 부정어 패턴 — 뒤따르는 키워드의 극성 반전 */
export const NEGATION_PATTERNS = [
  "안",
  "않",
  "못",
  "없",
  "아닌",
  "별로",
  "안되",
  "않은",
  "않는",
  "못하",
] as const;

/** 이모티콘/신조어 — 부정 신호 */
export const EMOTICON_NEGATIVE = [
  "ㅠㅠ",
  "ㅜㅜ",
  "ㅠ",
  "ㅜ",
  "ㅎㄷㄷ",
  "후덜덜",
  "ㄷㄷ",
] as const;

/** 이모티콘/신조어 — 긍정 신호 */
export const EMOTICON_POSITIVE = [
  "👍",
  "꿀팁",
  "강추",
  "ㄱㅊ",
  "괜찮",
] as const;

/** 강조어 — 인접 키워드 가중치 1.5배 */
export const INTENSIFIERS = [
  "ㄹㅇ",
  "ㅈㄴ",
  "진심",
  "진짜",
  "개",
  "존나",
  "너무",
  "엄청",
  "매우",
  "완전",
  "정말",
] as const;

// ---------------------------------------------------------------------------
// 2. 관련도 게이트 (Relevance Gate)
// ---------------------------------------------------------------------------

/** 주차 경험 키워드 (관련도 판별용, 긍정+부정 통합) */
const EXPERIENCE_KEYWORDS = [
  // 부정 경험
  "좁", "힘들", "무서", "긁", "어려", "공포", "골뱅이", "나선",
  "기계식", "기둥", "사이드미러", "복잡", "급경사", "만차", "대기",
  "헬", "hell", "지옥", "빡빡", "빡시", "빡세", "회전", "경사",
  // 긍정 경험 (주차 맥락 없이 단독 매칭될 수 있는 "추천" 등은 제외)
  "넓", "널널", "편하", "편리", "여유", "쉽", "초보",
  "평면", "자주식", "넉넉", "한산",
  // 구체적 주차 경험 서술
  "주차면", "주차장 입구", "진입", "출차", "주차 공간", "주차하기",
  "차폭", "주차타워", "발렛",
] as const;

/**
 * 텍스트의 주차 관련도 점수를 계산한다 (0.0 ~ 1.0).
 * 알고리즘 문서 §4.3 Step 1.
 *
 * - 주차 경험 키워드 2개 이상 → 1.0
 * - 주차 경험 키워드 1개 → 0.7
 * - "주차" 단어만 포함 → 0.3
 * - 주차 관련 키워드 없음 → 0.0
 */
export function computeRelevance(text: string): number {
  const t = text.toLowerCase();

  const matchCount = EXPERIENCE_KEYWORDS.filter((kw) =>
    t.includes(kw.toLowerCase()),
  ).length;

  if (matchCount >= 2) return 1.0;
  if (matchCount === 1) return 0.7;
  if (t.includes("주차")) return 0.3;
  return 0.0;
}

// ---------------------------------------------------------------------------
// 3. 토큰화 및 부정어 처리
// ---------------------------------------------------------------------------

interface Token {
  text: string;
  index: number;
}

/** 간단한 한국어 토큰화 (공백 + 조사 분리) */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  // 공백·구두점 기준 분할
  const parts = text.split(/[\s,.!?;:…·~]+/);
  let idx = 0;
  for (const part of parts) {
    if (part.length > 0) {
      tokens.push({ text: part, index: idx });
      idx++;
    }
  }
  return tokens;
}

/** 토큰이 감성 키워드를 포함하는지 확인 */
function containsSentimentKeyword(tokenText: string): boolean {
  const t = tokenText.toLowerCase();
  return (
    POSITIVE_KEYWORDS.some((kw) => t.includes(kw.toLowerCase())) ||
    NEGATIVE_KEYWORDS.some((kw) => t.includes(kw.toLowerCase()))
  );
}

/**
 * 부정어 ± 2어절 이내 키워드 → 극성 반전 감지.
 * "안 좁다" (부정어→키워드) + "넓지 않아서" (키워드→부정어) 모두 처리.
 * "넓지 않아서 힘들었어요" → "넓"만 반전, "힘들"은 유지 (앞에 키워드가 있으면 뒤 반전 억제)
 * 반환값: 부정어에 의해 반전되어야 하는 토큰 인덱스 Set
 */
function findNegatedIndices(tokens: Token[]): Set<number> {
  const negated = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].text;
    const isNegation = NEGATION_PATTERNS.some((np) => t.includes(np));
    if (!isNegation) continue;

    // 앞 2어절에서 키워드가 있는지 확인
    let hasBackwardKeyword = false;
    for (let j = Math.max(0, i - 2); j < i; j++) {
      if (containsSentimentKeyword(tokens[j].text)) {
        negated.add(j);
        hasBackwardKeyword = true;
      }
    }

    // 앞에 키워드가 없을 때만 뒤 2어절 반전 (e.g. "안 좁다")
    if (!hasBackwardKeyword) {
      for (let j = i + 1; j <= Math.min(i + 2, tokens.length - 1); j++) {
        negated.add(j);
      }
    }
  }
  return negated;
}

/**
 * 강조어 인접 토큰 감지.
 * 반환값: 강조 적용 대상 토큰 인덱스 Set
 */
function findIntensifiedIndices(tokens: Token[]): Set<number> {
  const intensified = new Set<number>();
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].text;
    if (INTENSIFIERS.some((intens) => t.includes(intens))) {
      // 뒤 1어절에 강조 적용
      if (i + 1 < tokens.length) {
        intensified.add(i + 1);
      }
    }
  }
  return intensified;
}

// ---------------------------------------------------------------------------
// 4. IDF 가중 감성 점수 계산
// ---------------------------------------------------------------------------

/** IDF 사전 타입 (keyword → idf value) */
export type IdfDict = Record<string, number>;

/** 기본 IDF 값 (사전에 없는 키워드) */
const DEFAULT_IDF = 0.5;

function getIdf(keyword: string, idfDict: IdfDict | null): number {
  if (!idfDict) return DEFAULT_IDF;
  return idfDict[keyword] ?? DEFAULT_IDF;
}

interface KeywordMatch {
  keyword: string;
  polarity: 1 | -1;
  idf: number;
  intensified: boolean;
}

/**
 * 텍스트에서 키워드를 매칭하고 극성/IDF/부정어/강조를 적용한 결과를 반환한다.
 */
function extractKeywordMatches(
  text: string,
  idfDict: IdfDict | null,
): KeywordMatch[] {
  const tokens = tokenize(text);
  const negatedIndices = findNegatedIndices(tokens);
  const intensifiedIndices = findIntensifiedIndices(tokens);
  const matches: KeywordMatch[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const tokenText = tokens[i].text.toLowerCase();

    for (const kw of POSITIVE_KEYWORDS) {
      if (tokenText.includes(kw.toLowerCase())) {
        const basePolarity = 1;
        const polarity = negatedIndices.has(i)
          ? ((-basePolarity) as 1 | -1)
          : basePolarity;
        matches.push({
          keyword: kw,
          polarity,
          idf: getIdf(kw, idfDict),
          intensified: intensifiedIndices.has(i),
        });
        break; // 토큰당 최대 1개 긍정 키워드
      }
    }

    for (const kw of NEGATIVE_KEYWORDS) {
      if (tokenText.includes(kw.toLowerCase())) {
        const basePolarity = -1;
        const polarity = negatedIndices.has(i)
          ? ((-basePolarity) as 1 | -1)
          : basePolarity;
        matches.push({
          keyword: kw,
          polarity,
          idf: getIdf(kw, idfDict),
          intensified: intensifiedIndices.has(i),
        });
        break; // 토큰당 최대 1개 부정 키워드
      }
    }
  }

  return matches;
}

/**
 * 이모티콘/신조어에서 추가 감성 신호를 추출한다.
 */
function extractEmoticonSignals(text: string): { positive: number; negative: number } {
  let positive = 0;
  let negative = 0;

  for (const em of EMOTICON_NEGATIVE) {
    if (text.includes(em)) negative++;
  }
  for (const em of EMOTICON_POSITIVE) {
    if (text.includes(em)) positive++;
  }

  return { positive, negative };
}

// ---------------------------------------------------------------------------
// 5. 감성 점수 산출 (공개 API)
// ---------------------------------------------------------------------------

export interface SentimentResult {
  /** 관련도 점수 0.0 ~ 1.0 */
  relevance: number;
  /** 원시 감성 점수 -1.0 ~ +1.0 (IDF 가중) */
  sentimentRaw: number;
  /** 1-5 스케일 변환 점수 (부정성 편향 보정 적용) */
  sentimentScore: number;
  /** 매칭된 키워드 수 */
  matchCount: number;
}

/**
 * 텍스트의 감성을 분석하여 SentimentResult를 반환한다.
 *
 * @param text - 분석할 텍스트 (블로그 본문, 댓글 등)
 * @param idfDict - IDF 사전 (null이면 기본 가중치 사용)
 */
export function analyzeSentiment(
  text: string,
  idfDict: IdfDict | null = null,
): SentimentResult {
  const relevance = computeRelevance(text);

  // 관련도 0이면 감성 분석 불필요
  if (relevance === 0) {
    return { relevance: 0, sentimentRaw: 0, sentimentScore: 3.0, matchCount: 0 };
  }

  const matches = extractKeywordMatches(text, idfDict);
  const emoticons = extractEmoticonSignals(text);

  // 이모티콘 신호를 키워드 매치에 추가 (IDF 0.3 고정)
  const EMOTICON_IDF = 0.3;
  for (let i = 0; i < emoticons.positive; i++) {
    matches.push({ keyword: "emoticon+", polarity: 1, idf: EMOTICON_IDF, intensified: false });
  }
  for (let i = 0; i < emoticons.negative; i++) {
    matches.push({ keyword: "emoticon-", polarity: -1, idf: EMOTICON_IDF, intensified: false });
  }

  if (matches.length === 0) {
    // 주차 키워드는 있지만 감성 키워드 없음 → 중립
    return { relevance, sentimentRaw: 0, sentimentScore: 3.0, matchCount: 0 };
  }

  // IDF 가중 감성 계산: Σ(polarity × idf × intensifier) / Σ(idf × intensifier)
  let weightedSum = 0;
  let weightSum = 0;

  for (const m of matches) {
    const w = m.idf * (m.intensified ? 1.5 : 1.0);
    weightedSum += m.polarity * w;
    weightSum += w;
  }

  const sentimentRaw = weightSum > 0 ? weightedSum / weightSum : 0;

  // 1-5 스케일 변환 + 부정성 편향 보정 (중립점 = +0.1)
  // S_text→5 = (S_text - 0.1) × 2.0 + 3.0
  const scaled = (sentimentRaw - 0.1) * 2.0 + 3.0;

  // 키워드 수 기반 감쇠: 키워드가 적으면 중립(3.0) 방향으로 당김
  const DAMPING: Record<number, number> = { 1: 0.5, 2: 0.7 };
  const damping = DAMPING[matches.length] ?? 1.0;
  const damped = 3.0 + (scaled - 3.0) * damping;
  const sentimentScore = Math.max(1.0, Math.min(5.0, damped));

  return {
    relevance,
    sentimentRaw: Math.round(sentimentRaw * 1000) / 1000,
    sentimentScore: Math.round(sentimentScore * 100) / 100,
    matchCount: matches.length,
  };
}

// ---------------------------------------------------------------------------
// 6. 시간 감쇠
// ---------------------------------------------------------------------------

const HALF_LIFE_DAYS = 365;

/**
 * 시간 감쇠 가중치를 계산한다.
 * d(t) = 0.5^(경과일수 / 365)
 *
 * @param publishedAt - ISO date string (e.g. "2024-06-15")
 * @param now - 기준 날짜 (기본: 오늘)
 */
export function timeDecay(publishedAt: string | null, now?: Date): number {
  if (!publishedAt) return 0.5; // 날짜 없으면 1년 전으로 간주

  const published = new Date(publishedAt);
  const reference = now ?? new Date();
  const daysDiff =
    (reference.getTime() - published.getTime()) / (1000 * 60 * 60 * 24);

  if (daysDiff < 0) return 1.0; // 미래 날짜 → 최신으로 처리
  return Math.pow(0.5, daysDiff / HALF_LIFE_DAYS);
}

// ---------------------------------------------------------------------------
// 7. 배치용 유틸: 주차장별 텍스트 감성 집계
// ---------------------------------------------------------------------------

export interface TextEntry {
  text: string;
  publishedAt: string | null;
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
  let weightedSum = 0;
  let weightSum = 0;
  let relevantCount = 0;

  for (const entry of entries) {
    const result = analyzeSentiment(entry.text, idfDict);

    // 관련도 0.3 이하는 감성 분석에서 완전 제외 (§5.1)
    if (result.relevance <= 0.3) continue;

    const decay = timeDecay(entry.publishedAt, now);
    const w = result.relevance * decay;

    weightedSum += w * result.sentimentScore;
    weightSum += w;
    relevantCount++;
  }

  if (weightSum === 0 || relevantCount === 0) return null;

  const score = Math.round((weightedSum / weightSum) * 100) / 100;
  // 유효 데이터량: 관련도 0.7 이상 텍스트만 카운트, 각 ×0.2
  const highRelevanceCount = entries.filter(
    (e) => computeRelevance(e.text) >= 0.7,
  ).length;
  const effectiveCount = Math.round(highRelevanceCount * 0.2 * 100) / 100;

  return {
    score: Math.max(1.0, Math.min(5.0, score)),
    count: relevantCount,
    effectiveCount,
  };
}
