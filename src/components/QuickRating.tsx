import { useState } from 'react'
import { toast } from 'sonner'
import { StarRatingInput } from '@/components/parking-reputation/StarRatingInput'
import { track } from '@/lib/analytics'
import { createReview } from '@/server/reviews'

interface QuickRatingProps {
  parkingLotId: string
  /** GA4 이벤트 이름 — 어느 진입점에서 등록됐는지 구분한다 (A-6 평가항목) */
  event: 'inline_rating_submitted' | 'review_prompt_rated'
  /** 별 앞에 붙는 짧은 질문. 빈 문자열이면 숨긴다 */
  prompt?: string
  onDone?: () => void
}

/**
 * 짧은 별점 입력 (A-6). 상세 패널의 ReviewForm 과 같은 방식으로 총점 하나를 다섯 항목에 넣는다.
 *
 * 별을 고른 뒤 「N점 등록」을 한 번 더 눌러야 등록된다. 목록을 스크롤하다 별을 스치기만 해도
 * 리뷰가 올라가면 난이도 점수(final_score)가 흔들린다 — 한 번의 확인을 둔 이유다.
 */
export function QuickRating({
  parkingLotId,
  event,
  prompt = '주차하기 쉬웠나요?',
  onDone,
}: QuickRatingProps) {
  const [score, setScore] = useState(0)
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle')

  if (state === 'done') {
    return <p className="text-xs text-muted-foreground">고맙습니다. 다음 분에게 큰 도움이 됩니다</p>
  }

  const submit = async () => {
    setState('sending')
    try {
      await createReview({
        data: {
          parkingLotId,
          entryScore: score,
          spaceScore: score,
          passageScore: score,
          exitScore: score,
          overallScore: score,
        },
      })
      track(event, { parking_lot_id: parkingLotId, score })
      setState('done')
      onDone?.()
    } catch (e) {
      setState('idle')
      toast.error(e instanceof Error ? e.message : '등록하지 못했습니다')
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {prompt && <span className="shrink-0 text-xs text-muted-foreground">{prompt}</span>}
      <StarRatingInput value={score} onChange={setScore} size="sm" />
      {score >= 0.5 && (
        <button
          type="button"
          onClick={submit}
          disabled={state === 'sending'}
          className="shrink-0 cursor-pointer rounded-full bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state === 'sending' ? '등록 중' : `${score}점 등록`}
        </button>
      )}
    </div>
  )
}
