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

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const API_URL = 'https://api.anthropic.com/v1/messages'

/** summary 최소 길이. 미만이면 filter_passed=false 강제 적용 */
export const MIN_SUMMARY_LENGTH = 200

export interface AiFilterResult {
  /** 광고/무관 콘텐츠 필터 통과 (true=주차 후기, false=광고/무관) */
  filterPassed: boolean
  /** 필터 미통과 사유 (광고, 부동산, 무관 등) */
  filterRemovedBy: string | null
  /** 난이도 관련 키워드 */
  difficultyKeywords: string[]
  /** 감성 점수 1.0(매우 어려움) ~ 5.0(매우 쉬움) */
  sentimentScore: number
  /** 주차장 종합 가이드 요약 (200~600자 권장) */
  summary: string
  /** 요금 관련 꿀팁 */
  tipPricing: string | null
  /** 방문 및 이용 팁 */
  tipVisit: string | null
  /** 만차 시 대안 정보 */
  tipAlternative: string | null
}

export interface AiFilterInput {
  parkingName: string
  title: string
  description: string
}

const SYSTEM_PROMPT = `주차장 검색 결과를 분석하여 초보 운전자를 위한 '독창적인 주차 가이드'를 생성하는 JSON 분류기입니다.

출력 형식 (JSON 객체만, 설명 없이):
{
  "filter_passed": true/false,
  "removed_by": null 또는 "ad"/"realestate"/"irrelevant"/"news",
  "difficulty_keywords": ["좁다", "기계식"],
  "sentiment_score": 3.0,
  "summary": "종합 분석 (200~600자)",
  "tip_pricing": "요금 절약 방법이나 무료 조건",
  "tip_visit": "가장 쾌적한 방문 시간이나 진입로 주의점",
  "tip_alternative": "만차 시 근처 추천 주차장"
}

판단 기준:
- filter_passed: 주차장에 대한 유용한 정보가 있으면 true. 광고, 부동산, 단순 뉴스 등은 false.
- summary: 본문에서 주차 관련 정보를 최대한 추출하여 200~600자 범위로 작성하세요.
  - 다음 항목 중 본문에 있는 것은 모두 포함하세요: 진입로(폭/회전반경/일방통행 여부), 주차면(크기/기둥/경사), 통로(너비/회전 여유), 요금(시간당/일일/할인 조건), 혼잡도(시간대별/요일별), 층별 특징, 출입구 위치, 보행 동선.
  - "이곳은 ~합니다" 식의 3인칭 관찰자 시점보다는 "주차 공간이 좁아 초보자는 주의가 필요합니다" 같은 실용적 정보를 담으세요.
  - 단순히 "주차하기 좋습니다"가 아니라 "통로가 넓어 회전 시 여유가 있습니다"처럼 이유를 설명하세요.
  - 단순 한 줄 요약 금지. "~정보", "~안내", "~확인 가능", "~이용 가능" 같은 메타 표현 금지.
  - 본문에 없는 내용 추측·창작 금지. 본문 텍스트를 그대로 잘라붙이는 것도 금지(이해 후 재작성).
- tip_pricing: 모두가 아는 기본 요금보다는 '유료 결제 시 할인 방법', '주변 상가 이용 시 무료 혜택', '공영주차장 할인 대상' 등을 적으세요.
- tip_visit: "평일 오후 2시 이후에는 자리가 많습니다", "입구 진입 시 좌회전 신호가 짧으니 미리 차선을 변경하세요" 등 실전 팁을 적으세요.
- tip_alternative: 해당 주차장이 만차이거나 너무 좁을 때 이용할 수 있는 '도보 5분 이내'의 대안 주차장을 언급하세요.

주의:
- 각 팁 필드는 본문에 구체 정보가 없으면 null로 설정.
- summary는 반드시 200자 이상의 충분한 정보를 담아야 합니다. 본문에 주차 관련 구체 정보가 부족하면 filter_passed를 false로 설정하세요.`

/**
 * 여러 검색 결과를 한번에 분류 (배치 프롬프트, 최대 10건)
 */
export async function classifyBatch(
  inputs: AiFilterInput[],
  apiKey: string,
): Promise<AiFilterResult[]> {
  if (inputs.length === 0) return []

  const itemsText = inputs
    .map(
      (input, i) =>
        `[${i + 1}] 주차장: ${input.parkingName} | 제목: ${input.title} | 설명: ${input.description.slice(0, 500)}`, // 분석을 위해 설명 길이를 500자로 늘림
    )
    .join('\n')

  const systemPrompt =
    inputs.length === 1
      ? SYSTEM_PROMPT
      : `${SYSTEM_PROMPT}\n\n여러 항목이 주어집니다. JSON 배열로 출력하세요.`

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 1200 * inputs.length, // long-form summary(200~600자) + tip 3개 출력 여유
      system: systemPrompt,
      messages: [{ role: 'user', content: itemsText }],
    }),
    signal: AbortSignal.timeout(45_000), // 타임아웃 약간 상향
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Haiku API ${res.status}: ${text}`)
  }

  const data = (await res.json()) as {
    content: Array<{ type: string; text: string }>
  }

  const text = data.content[0]?.text ?? ''

  if (inputs.length === 1) {
    return [parseOne(text)]
  }
  return parseBatch(text, inputs.length)
}

function parseOne(text: string): AiFilterResult {
  try {
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) return defaultResult()
    const p = JSON.parse(m[0])
    return toResult(p)
  } catch {
    return defaultResult()
  }
}

function parseBatch(text: string, count: number): AiFilterResult[] {
  try {
    const m = text.match(/\[[\s\S]*\]/)
    if (!m) return Array(count).fill(defaultResult())
    const arr = JSON.parse(m[0]) as unknown[]
    return arr.map((item) => toResult(item as Record<string, unknown>))
  } catch {
    return Array(count).fill(defaultResult())
  }
}

export function toResult(p: Record<string, unknown>): AiFilterResult {
  const llmPassed = Boolean(p.filter_passed)
  const summary = String(p.summary ?? '')
  // summary가 MIN_SUMMARY_LENGTH 미만이면 filter_passed=false 강제 적용
  // (LLM이 200자 이상 지시를 무시하고 짧게 출력하는 회귀 방지)
  const tooShort = summary.length < MIN_SUMMARY_LENGTH
  const passed = llmPassed && !tooShort
  const removedBy = tooShort
    ? 'short_summary'
    : llmPassed
      ? null
      : String(p.removed_by ?? 'unknown')

  return {
    filterPassed: passed,
    filterRemovedBy: removedBy,
    difficultyKeywords: Array.isArray(p.difficulty_keywords)
      ? (p.difficulty_keywords as string[])
      : [],
    sentimentScore: clamp(Number(p.sentiment_score) || 3.0),
    summary,
    tipPricing: p.tip_pricing ? String(p.tip_pricing) : null,
    tipVisit: p.tip_visit ? String(p.tip_visit) : null,
    tipAlternative: p.tip_alternative ? String(p.tip_alternative) : null,
  }
}

function defaultResult(): AiFilterResult {
  return {
    filterPassed: false,
    filterRemovedBy: 'ai_error',
    difficultyKeywords: [],
    sentimentScore: 3.0,
    summary: '분류 실패',
    tipPricing: null,
    tipVisit: null,
    tipAlternative: null,
  }
}

function clamp(n: number): number {
  return Math.max(1.0, Math.min(5.0, Math.round(n * 100) / 100))
}
