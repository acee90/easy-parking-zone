/**
 * 셀프호스팅 Unsloth(llama.cpp) OpenAI 호환 엔드포인트 클라이언트 — single source of truth
 *
 * Anthropic 에서 전환한 이유: 운영 ANTHROPIC_API_KEY 가 만료되어 AI 단계가 통째로
 * 실패하고 있었다(로그에 401 authentication_error 반복, 에러를 삼켜 드러나지 않음).
 *
 * 서버 특성 (2026-08-19 실측, system_fingerprint b1-dd9280a):
 *  - `response_format: json_object` 를 **받아들이지만 강제하지는 않는다** — 응답이
 *    ```json 펜스로 감싸여 온다. 파싱 전 펜스 제거 필수.
 *  - reasoning 모델이라 json 모드에선 추론이 `reasoning_content` 로 분리되지만,
 *    모드가 없으면 `<think>…</think>` 가 본문에 섞인다. 양쪽 모두 방어한다.
 *  - 토큰이 모자라면 finish_reason='length' 로 잘려 content 가 **빈 문자열**이 된다
 *    (에러가 아니라 조용한 실패). 호출부가 상수항을 넉넉히 잡아야 한다.
 *
 * 이 파일은 `match-to-lots.ts` 안에 있던 것을 꺼낸 것이다. 같은 엔드포인트를 쓰는
 * 호출부가 셋(매칭 검증 · 글 요약 · 종합 요약)으로 늘면서 파싱 방어 로직이
 * 복사될 참이었다.
 */

export const DEFAULT_AI_MODEL = 'unsloth/gemma-4-E4B-it-GGUF'
export const DEFAULT_AI_BASE_URL = 'https://unsloth.arttoken.biz/v1'

/** 셀프호스팅 소형모델이라 응답이 느리다 */
const REQUEST_TIMEOUT_MS = 120_000

export interface AiCallOptions {
  apiKey: string
  system: string
  user: string
  maxTokens: number
  model?: string
  baseUrl?: string
}

/**
 * 펜스·reasoning 잔재를 걷어내고 JSON 으로 판다.
 * 실패하면 null — 호출부가 폴백을 정한다.
 *
 * 순수 함수. 테스트는 `ai-client.test.ts`.
 */
export function parseAiJson<T>(text: string): T | null {
  const jsonText = text
    .replace(/<think>[\s\S]*?<\/think>/g, '') // reasoning 인라인 출력 제거
    .replace(/^[\s\S]*?```(?:json)?\n?/, '') // 앞쪽 잡담 + 펜스 시작 제거
    .replace(/```[\s\S]*$/, '') // 펜스 종료 이후 제거
    .trim()
  if (!jsonText) return null
  try {
    return JSON.parse(jsonText) as T
  } catch {
    return null
  }
}

/** 응답 본문 텍스트를 그대로 돌려준다 (파싱은 호출부 몫) */
export async function callAiText(opts: AiCallOptions): Promise<string> {
  const baseUrl = opts.baseUrl || DEFAULT_AI_BASE_URL
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model || DEFAULT_AI_MODEL,
      max_tokens: opts.maxTokens,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user },
      ],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!res.ok) {
    throw new Error(`AI API ${res.status}: ${await res.text()}`)
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  return data.choices?.[0]?.message?.content ?? ''
}
