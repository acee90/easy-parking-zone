/**
 * AI 필터링 모듈 (Anthropic Haiku)
 *
 * 크롤링된 검색 결과를 Haiku로 분류:
 * 1. 광고/무관 콘텐츠 필터 → filter_passed / filter_removed_by
 * 2. 난이도 관련 키워드 추출 → ai_difficulty_keywords
 * 3. 감성 점수 산출 → sentiment_score (기존 컬럼 재활용)
 * 4. 한줄 요약 → ai_summary
 *
 * Workers 환경 + 로컬 스크립트 모두 호환.
 */

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";

export interface AiFilterResult {
  /** 광고/무관 콘텐츠 필터 통과 (true=주차 후기, false=광고/무관) */
  filterPassed: boolean;
  /** 필터 미통과 사유 (광고, 부동산, 무관 등) */
  filterRemovedBy: string | null;
  /** 난이도 관련 키워드 */
  difficultyKeywords: string[];
  /** 감성 점수 1.0(매우 어려움) ~ 5.0(매우 쉬움) */
  sentimentScore: number;
  /** 한줄 요약 */
  summary: string;
}

export interface AiFilterInput {
  parkingName: string;
  title: string;
  description: string;
}

const SYSTEM_PROMPT = `주차장 검색 결과를 분류하는 JSON 분류기입니다.

출력 형식 (JSON 객체만, 설명 없이):
{
  "filter_passed": true/false,
  "removed_by": null 또는 "ad"/"realestate"/"irrelevant",
  "difficulty_keywords": ["좁다", "기계식"],
  "sentiment_score": 3.0,
  "summary": "주차면 좁고 기둥 많음"
}

판단 기준:
- filter_passed: 실제 주차 경험/정보 글이면 true. 광고("ad"), 부동산 분양("realestate"), 주차 무관("irrelevant")이면 false.
- difficulty_keywords: 주차 난이도 관련 표현만 추출 (좁다, 넓다, 기계식, 경사, 회전, 기둥, 복잡, 편하다, 여유, 만차, 헬, 초보추천 등). 없으면 빈 배열.
- sentiment_score: 초보 운전자 관점 주차 용이성. 1.0=매우어려움, 3.0=보통, 5.0=매우쉬움. 판단 불가 시 3.0.
- summary: 주차 관련 핵심 한줄 (20자 이내). 필터 미통과 시 "광고"/"무관" 등.`;

/**
 * 여러 검색 결과를 한번에 분류 (배치 프롬프트, 최대 10건)
 */
export async function classifyBatch(
  inputs: AiFilterInput[],
  apiKey: string,
): Promise<AiFilterResult[]> {
  if (inputs.length === 0) return [];

  const itemsText = inputs
    .map(
      (input, i) =>
        `[${i + 1}] 주차장: ${input.parkingName} | 제목: ${input.title} | 설명: ${input.description.slice(0, 200)}`,
    )
    .join("\n");

  const systemPrompt =
    inputs.length === 1
      ? SYSTEM_PROMPT
      : SYSTEM_PROMPT +
        "\n\n여러 항목이 주어집니다. JSON 배열로 출력하세요.";

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 200 * inputs.length,
      system: systemPrompt,
      messages: [{ role: "user", content: itemsText }],
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Haiku API ${res.status}: ${text}`);
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text: string }>;
  };

  const text = data.content[0]?.text ?? "";

  if (inputs.length === 1) {
    return [parseOne(text)];
  }
  return parseBatch(text, inputs.length);
}

function parseOne(text: string): AiFilterResult {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return defaultResult();
    const p = JSON.parse(m[0]);
    return toResult(p);
  } catch {
    return defaultResult();
  }
}

function parseBatch(text: string, count: number): AiFilterResult[] {
  try {
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) return Array(count).fill(defaultResult());
    const arr = JSON.parse(m[0]) as unknown[];
    return arr.map((item) => toResult(item as Record<string, unknown>));
  } catch {
    return Array(count).fill(defaultResult());
  }
}

function toResult(p: Record<string, unknown>): AiFilterResult {
  const passed = Boolean(p.filter_passed);
  return {
    filterPassed: passed,
    filterRemovedBy: passed ? null : String(p.removed_by ?? "unknown"),
    difficultyKeywords: Array.isArray(p.difficulty_keywords)
      ? (p.difficulty_keywords as string[])
      : [],
    sentimentScore: clamp(Number(p.sentiment_score) || 3.0),
    summary: String(p.summary ?? "").slice(0, 50),
  };
}

function defaultResult(): AiFilterResult {
  return {
    filterPassed: false,
    filterRemovedBy: "ai_error",
    difficultyKeywords: [],
    sentimentScore: 3.0,
    summary: "분류 실패",
  };
}

function clamp(n: number): number {
  return Math.max(1.0, Math.min(5.0, Math.round(n * 100) / 100));
}
