/**
 * AI 필터링 모듈 (Anthropic Haiku) — raw 단계 진입점
 *
 * 신규 크롤링된 검색 결과(`web_sources_raw`)를 Haiku로 분류:
 * 1. 광고/무관 콘텐츠 필터 → filter_passed / filter_removed_by
 * 2. 난이도 관련 키워드 추출 → ai_difficulty_keywords
 * 3. 감성 점수 산출 → sentiment_score
 * 4. long-form 요약 → ai_summary (200~600자)
 *
 * SYSTEM_PROMPT 사양은 `./ai-summary-prompt.ts`에 single source of truth로 분리.
 * 매칭 후 재생성(`ai-summary-generator` agent)도 동일 사양 따름 (SKILL.md 참조).
 *
 * Workers 환경 + 로컬 스크립트 모두 호환.
 */

import { AI_SUMMARY_SYSTEM_PROMPT, MIN_SUMMARY_LENGTH } from './ai-summary-prompt'

export { MIN_SUMMARY_LENGTH }

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const API_URL = 'https://api.anthropic.com/v1/messages'

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

const SYSTEM_PROMPT = AI_SUMMARY_SYSTEM_PROMPT

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
