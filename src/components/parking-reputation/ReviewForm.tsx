import { useState } from 'react'
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
      onSubmitted()
    } catch (e) {
      setError(e instanceof Error ? e.message : '오류가 발생했습니다')
    } finally {
      setSubmitting(false)
    }
  }

  const hasScore = overallScore >= 0.5

  return (
    <div className="rounded-xl border-2 border-yellow-100 bg-gradient-to-br from-yellow-50 to-white p-5">
      <div className="mb-4 text-center">
        <p className="text-base font-semibold text-zinc-900">주차하기 쉬웠나요?</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {hasScore ? MICROCOPY[overallScore] : '별을 클릭해 평점을 남겨주세요'}
        </p>
      </div>

      <div className="mb-4 flex justify-center">
        <StarRatingInput value={overallScore} onChange={setOverallScore} size="lg" />
      </div>

      {hasScore && (
        <div className="space-y-3 border-t border-yellow-100 pt-4">
          {!session && (
            <input
              type="text"
              value={guestNickname}
              onChange={(e) => setGuestNickname(e.target.value)}
              placeholder="닉네임 (선택)"
              maxLength={20}
              className="w-full rounded-md border bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-300"
            />
          )}

          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={200}
            rows={3}
            placeholder="진입로, 주차면 크기, 통로 여유, 출차 난이도 등 경험을 적어주세요 (선택)"
            className="w-full resize-none rounded-md border bg-white px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-yellow-300"
          />

          {error && <p className="text-xs text-red-500">{error}</p>}

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full cursor-pointer rounded-md bg-yellow-500 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-yellow-600 disabled:cursor-not-allowed disabled:opacity-50"
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
