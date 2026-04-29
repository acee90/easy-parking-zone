import { Star } from 'lucide-react'
import { useState } from 'react'
import { authClient } from '@/lib/auth-client'
import { createReview } from '@/server/reviews'

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
    if (overallScore < 1) return
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

  return (
    <div className="rounded-lg border p-3 space-y-3">
      {!session && (
        <input
          type="text"
          value={guestNickname}
          onChange={(e) => setGuestNickname(e.target.value)}
          placeholder="닉네임 (선택)"
          maxLength={20}
          className="w-full rounded-md border px-2.5 py-1.5 text-sm"
        />
      )}

      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">초보 추천도</span>
        <StarRating value={overallScore} onChange={setOverallScore} />
      </div>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        maxLength={200}
        rows={2}
        placeholder="진입로, 주차면 크기, 통로 여유, 출차 난이도 등 경험을 적어주세요"
        className="w-full rounded-md border px-2.5 py-1.5 text-sm resize-none"
      />

      {error && <p className="text-sm text-red-500">{error}</p>}

      <button
        type="button"
        onClick={handleSubmit}
        disabled={overallScore < 1 || submitting}
        className="w-full rounded-md bg-blue-500 py-2 text-sm font-medium text-white hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
      >
        {submitting ? '등록 중...' : '등록하기'}
      </button>

      {!session && (
        <p className="text-xs text-muted-foreground text-center">
          로그인하면 리뷰를 수정/삭제할 수 있어요
        </p>
      )}
    </div>
  )
}

function StarRating({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <button key={n} type="button" onClick={() => onChange(n)} className="cursor-pointer p-0.5">
          <Star
            className={`size-4 ${n <= value ? 'fill-yellow-400 text-yellow-400' : 'text-gray-300'}`}
          />
        </button>
      ))}
    </div>
  )
}
