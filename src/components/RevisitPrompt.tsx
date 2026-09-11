import { useEffect } from 'react'
import { toast } from 'sonner'
import { QuickRating } from '@/components/QuickRating'
import { track } from '@/lib/analytics'
import { takePendingPrompt } from '@/lib/last-nav'

/** 첫 화면을 그린 뒤 잠깐 기다렸다 묻는다 */
const PROMPT_DELAY_MS = 1200

/**
 * 재방문 프롬프트 (A-6). 지난번 길찾기로 떠난 주차장이 있으면 한 번 물어본다.
 * 조건(2시간~14일, 1회)은 last-nav.ts 가 갖는다. 화면에는 아무것도 그리지 않는다.
 */
export function RevisitPrompt() {
  useEffect(() => {
    // 바로 띄우지 않는다. 이 컴포넌트는 페이지 안쪽에 있고 <Toaster> 는 <body> 끝에 있어서
    // effect 가 Toaster 구독보다 먼저 돈다 — 그 사이에 만든 토스트는 sonner 가 버린다
    // (실측: 기록은 소비됐는데 토스트가 안 떴다). 잠깐 기다리는 편이 첫 화면에도 덜 거슬린다.
    const timer = setTimeout(showPendingPrompt, PROMPT_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  return null
}

function showPendingPrompt() {
  const pending = takePendingPrompt()
  if (!pending) return
  track('review_prompt_shown', { parking_lot_id: pending.lotId })
  toast.custom(
    (id) => (
      <div className="w-[min(92vw,360px)] rounded-xl border bg-white p-4 shadow-lg">
        <div className="flex items-start justify-between gap-3">
          <p className="text-sm font-semibold text-ink">지난번 {pending.name} 어땠나요?</p>
          <button
            type="button"
            onClick={() => toast.dismiss(id)}
            className="shrink-0 cursor-pointer text-xs text-muted-foreground hover:text-foreground"
          >
            닫기
          </button>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">다음 사람을 위해 별점을 남겨주세요</p>
        <div className="mt-3">
          <QuickRating
            parkingLotId={pending.lotId}
            event="review_prompt_rated"
            prompt=""
            onDone={() => setTimeout(() => toast.dismiss(id), 1500)}
          />
        </div>
      </div>
    ),
    { duration: 30_000 },
  )
}
