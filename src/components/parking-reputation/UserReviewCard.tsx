import { ExternalLink, User } from 'lucide-react'
import { ReportButton } from '@/components/ReportDialog'
import type { UserReview } from '@/types/parking'
import { StarDisplay } from './StarDisplay'

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
    <div className="group relative flex h-full flex-col rounded-2xl border bg-white p-5 transition-all hover:shadow-md">
      {!review.isMine && (
        <div className="absolute right-3 top-3 opacity-0 transition-opacity group-hover:opacity-100">
          <ReportButton targetType="review" targetId={review.id} parkingLotId={lotId} />
        </div>
      )}

      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            {review.author.profileImage ? (
              <img
                src={review.author.profileImage}
                alt=""
                className="size-10 rounded-full border object-cover"
              />
            ) : (
              <div className="flex size-10 items-center justify-center rounded-full bg-zinc-100 text-zinc-400">
                <User className="size-6" />
              </div>
            )}
          </div>
          <div className="flex flex-col">
            <span className="text-base font-bold text-zinc-900">{review.author.nickname}</span>
            <div className="flex items-center gap-2">
              <StarDisplay score={review.scores.overall} />
              <span className="text-xs text-zinc-400">{review.createdAt.slice(0, 10)}</span>
            </div>
          </div>
        </div>

        {review.sourceType && (
          <div className="shrink-0">
            {review.sourceUrl ? (
              <a
                href={review.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-lg bg-orange-50 px-2.5 py-1 text-xs font-bold text-orange-600 transition-colors hover:bg-orange-100"
              >
                {REVIEW_SOURCE_LABELS[review.sourceType] ?? review.sourceType}
                <ExternalLink className="size-3" />
              </a>
            ) : (
              <span className="inline-flex items-center rounded-lg bg-orange-50 px-2.5 py-1 text-xs font-bold text-orange-600">
                {REVIEW_SOURCE_LABELS[review.sourceType] ?? review.sourceType}
              </span>
            )}
          </div>
        )}
      </div>

      {review.comment && (
        <div className="flex-1">
          <p className="text-sm leading-relaxed text-zinc-700 whitespace-pre-line">
            {review.comment}
          </p>
        </div>
      )}

      {review.isMine && onDelete && (
        <div className="mt-4 flex items-center justify-end border-t pt-3">
          <button
            type="button"
            onClick={onDelete}
            className="text-xs font-medium text-red-500 hover:text-red-700 hover:underline"
          >
            삭제하기
          </button>
        </div>
      )}
    </div>
  )
}
