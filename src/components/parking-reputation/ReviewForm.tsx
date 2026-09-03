import { useState } from 'react'
import { toast } from 'sonner'
import { authClient } from '@/lib/auth-client'
import { createReview } from '@/server/reviews'
import { StarRatingInput } from './StarRatingInput'

const MICROCOPY: Record<number, string> = {
  0.5: '아주 어려워요',
  1: '어려워요',
  1.5: '꽤 어려워요',
  2: '조금 어려워요',
  2.5: '보통이에요',
  3: '괜찮아요',
  3.5: '쉬운 편이에요',
  4: '쉬워요',
  4.5: '아주 쉬워요',
  5: '누구나 쉽게 주차',
}

export function ReviewForm({
  parkingLotId,
  onSubmitted,
}: {
  parkingLotId: string
  onSubmitted: () => void
}) {
  const { data: session } = authClient.useSession()
  const [overallScore, setOverallScore] = useState(0)
  const [comment, setComment] = useState('')
  const [guestNickname, setGuestNickname] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async () => {
    if (overallScore < 0.5) return
    setSubmitting(true)
    setError(null)
    try {
      await createReview({
        data: {
          parkingLotId,
          entryScore: overallScore,
          spaceScore: overallScore,
          passageScore: overallScore,
          exitScore: overallScore,
          overallScore,
          comment: comment || undefined,
          guestNickname: session ? undefined : guestNickname || undefined,
        },
      })
      // 폼 초기화 — 별점을 0으로 되돌리면 입력 영역이 접히며 등록 완료가 눈에 보인다.
      // 닉네임은 다음 리뷰에서 다시 쓰도록 유지.
      setOverallScore(0)
      setComment('')
      toast.success('리뷰가 등록되었습니다')
      onSubmitted()
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류가 발생했습니다')
    } finally {
      setSubmitting(false)
    }
  }

  const hasScore = overallScore >= 0.5

  return (
    // 시트 안이라 표면을 덧씌우지 않는다 (디자인 규칙 §5).
    // 별점만 받는 폼인데 세로로 쌓아 가운데 정렬하면 화면 한 장을 통째로 먹는다 —
    // 질문과 별점을 한 줄에 두어 접힌 상태의 높이를 줄인다.
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[14px] font-bold text-ink">주차하기 쉬웠나요?</p>
          <p className="mt-0.5 text-[11.5px] text-faint">
            {hasScore ? MICROCOPY[overallScore] : '별을 클릭해 평점을 남겨주세요'}
          </p>
        </div>
        <StarRatingInput value={overallScore} onChange={setOverallScore} size="lg" />
      </div>

      {hasScore && (
        <div className="mt-4 space-y-3 border-t border-zinc-100 pt-4">
          {!session && (
            <input
              type="text"
              value={guestNickname}
              onChange={(e) => setGuestNickname(e.target.value)}
              placeholder="닉네임 (선택)"
              maxLength={20}
              className="w-full rounded-lg bg-zinc-50 px-3 py-2 text-sm transition-shadow focus:outline-none focus:ring-2 focus:ring-ring/60"
            />
          )}

          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={200}
            rows={3}
            placeholder="진입로, 주차면 크기, 통로 여유, 출차 난이도 등 경험을 적어주세요 (선택)"
            className="w-full resize-none rounded-lg bg-zinc-50 px-3 py-2 text-sm leading-relaxed transition-shadow focus:outline-none focus:ring-2 focus:ring-ring/60"
          />

          {error && <p className="text-xs text-red-500">{error}</p>}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full cursor-pointer rounded-lg bg-primary py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 active:bg-primary/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? '등록 중...' : '평가 등록'}
          </button>

          {!session && (
            <p className="text-center text-xs text-muted-foreground">
              로그인하면 리뷰를 수정/삭제할 수 있어요
            </p>
          )}
        </div>
      )}
    </div>
  )
}
