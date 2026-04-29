import { ExternalLink, Star, User } from 'lucide-react'
import { ReportButton } from '@/components/ReportDialog'
import type { UserReview } from '@/types/parking'

const REVIEW_SOURCE_LABELS: Record<string, string> = {
  clien: '클리앙',
}

export function UserReviewCard({
  review,
  lotId,
  onDelete,
}: {
  review: UserReview
  lotId: string
  onDelete?: () => void
}) {
  return (
    <div className="rounded-xl bg-muted px-4 py-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          {review.author.profileImage ? (
            <img src={review.author.profileImage} alt="" className="size-7 rounded-full" />
          ) : (
            <User className="size-5 text-muted-foreground" />
          )}
          <span className="truncate text-base font-semibold">{review.author.nickname}</span>
          {review.sourceType &&
            (review.sourceUrl ? (
              <a
                href={review.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-600 transition-colors hover:bg-orange-100"
              >
                {REVIEW_SOURCE_LABELS[review.sourceType] ?? review.sourceType}
                <ExternalLink className="size-2.5" />
              </a>
            ) : (
              <span className="inline-flex shrink-0 items-center rounded-full bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-600">
                {REVIEW_SOURCE_LABELS[review.sourceType] ?? review.sourceType}
              </span>
            ))}
        </div>
        <div className="shrink-0 space-y-1 text-right">
          <div className="flex gap-0.5">
            {[1, 2, 3, 4, 5].map((n) => (
              <Star
                key={n}
                className={`size-3.5 ${n <= review.scores.overall ? 'fill-yellow-400 text-yellow-400' : 'text-gray-200'}`}
              />
            ))}
          </div>
          <div className="text-xs text-muted-foreground">{review.createdAt.slice(0, 10)}</div>
        </div>
      </div>
      {review.comment && (
        <p className="text-base leading-relaxed text-gray-700">{review.comment}</p>
      )}
      <div className="mt-3 flex items-center justify-end gap-2">
        {!review.isMine && (
          <ReportButton targetType="review" targetId={review.id} parkingLotId={lotId} />
        )}
        {review.isMine && onDelete && (
          <button
            type="button"
            onClick={onDelete}
            className="cursor-pointer text-sm text-red-400 hover:text-red-600"
          >
            삭제
          </button>
        )}
      </div>
    </div>
  )
}
