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
    // 회색 필은 인풋 전용이다 (디자인 규칙 §2) — 이 블록이 정확히 그 용도다.
    // 시트 안에서 유일하게 "여기는 눌러서 입력하는 곳"이라고 말하는 면이라,
    // 표면을 덧씌우는 게 아니라 인풋임을 드러내는 것이다.
    //
    // 크게 그리는 이유: 후기를 모으는 게 이 사이트의 정체성인데, 앞서 여백을 줄이면서
    // 한 줄로 눌러놨더니 페이지에서 가장 안 보이는 블록이 됐다.
    <div className="rounded-[10px] bg-zinc-50 px-4 py-5 sm:px-5">
      <div className="flex flex-col items-center gap-3 text-center">
        <div>
          <p className="text-[17px] font-extrabold tracking-[-0.015em] text-ink">
            주차하기 쉬웠나요?
          </p>
          <p className="mt-1 text-[13px] text-ink-2">
            {hasScore ? MICROCOPY[overallScore] : '별 하나만 눌러주세요 · 30초면 됩니다'}
          </p>
        </div>
        <StarRatingInput value={overallScore} onChange={setOverallScore} size="xl" />
        {!hasScore && (
          <p className="text-[11.5px] text-faint">
            다음에 여기 올 사람이 미리 알 수 있게 도와주세요
          </p>
        )}
      </div>

      {hasScore && (
        <div className="mt-4 space-y-3 border-t border-zinc-200 pt-4">
          {!session && (
            <input
              type="text"
              value={guestNickname}
              onChange={(e) => setGuestNickname(e.target.value)}
              placeholder="닉네임 (선택)"
              maxLength={20}
              className="w-full rounded-lg bg-white px-3 py-2 text-sm transition-shadow focus:outline-none focus:ring-2 focus:ring-ring/60"
            />
          )}

          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={200}
            rows={3}
            placeholder="진입로, 주차면 크기, 통로 여유, 출차 난이도 등 경험을 적어주세요 (선택)"
            className="w-full resize-none rounded-lg bg-white px-3 py-2 text-sm leading-relaxed transition-shadow focus:outline-none focus:ring-2 focus:ring-ring/60"
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
