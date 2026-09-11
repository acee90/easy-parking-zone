/**
 * GA4 이벤트 전송. gtag 는 __root.tsx 가 인라인 스크립트로 심는다.
 * SSR·광고차단·스크립트 로드 전에는 조용히 아무것도 하지 않는다 — 측정 실패가 기능을 막으면 안 된다.
 */

declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void
  }
}

export function track(event: string, params: Record<string, unknown> = {}): void {
  try {
    if (typeof window !== 'undefined' && typeof window.gtag === 'function') {
      window.gtag('event', event, params)
    }
  } catch {
    // 측정은 부가 기능이다
  }
}
