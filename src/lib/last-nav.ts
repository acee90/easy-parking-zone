/**
 * 「길찾기로 떠난 주차장」을 기억했다가 다음 방문에 한 번 물어본다 (A-6 재방문 프롬프트).
 *
 * 저장은 이 브라우저의 localStorage 뿐이다 — 서버로 보내지 않는다.
 * localStorage 가 막힌 환경(사생활 보호 모드 등)에서는 조용히 아무것도 하지 않는다.
 */

const KEY = 'ep:last-nav'

/** 너무 이르면 아직 주차 중일 수 있다 — 지우지 않고 다음 방문에 다시 본다 */
export const PROMPT_MIN_AGE_MS = 2 * 60 * 60 * 1000
/** 너무 오래되면 기억이 흐리다 — 묻지 않고 버린다 */
export const PROMPT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

export interface LastNav {
  lotId: string
  name: string
  at: number
}

export function recordNavigation(lotId: string, name: string, now = Date.now()): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ lotId, name, at: now } satisfies LastNav))
  } catch {
    // 저장이 막힌 환경
  }
}

/** 물어볼 때가 된 기록을 꺼낸다. 꺼낸 기록은 지운다 — 한 번만 묻는다. */
export function takePendingPrompt(now = Date.now()): LastNav | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<LastNav>
    if (
      !v ||
      typeof v.lotId !== 'string' ||
      typeof v.name !== 'string' ||
      typeof v.at !== 'number'
    ) {
      localStorage.removeItem(KEY)
      return null
    }
    const age = now - v.at
    if (age > PROMPT_MAX_AGE_MS || age < 0) {
      localStorage.removeItem(KEY)
      return null
    }
    if (age < PROMPT_MIN_AGE_MS) return null
    localStorage.removeItem(KEY)
    return { lotId: v.lotId, name: v.name, at: v.at }
  } catch {
    return null
  }
}
