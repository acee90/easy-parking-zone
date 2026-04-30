import { Pen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { deleteReview, fetchUserReviews } from '@/server/reviews'
import type { UserReview } from '@/types/parking'
import { Carousel, CarouselSlide } from './Carousel'
import { ReviewForm } from './ReviewForm'
import { SectionTitle } from './SectionTitle'
import { UserReviewCard } from './UserReviewCard'

const CAROUSEL_LIMIT = 7

interface ReviewSectionProps {
  lotId: string
  count: number
  initialReviews?: UserReview[]
  showTitle?: boolean
  className?: string
  onRefreshCount?: () => void
  viewAllSlug?: string
}

export function ReviewSection({
  lotId,
  count,
  initialReviews,
  showTitle = true,
  className,
  onRefreshCount,
  viewAllSlug,
}: ReviewSectionProps) {
  const [reviews, setReviews] = useState<UserReview[]>(initialReviews ?? [])
  const [showReviewForm, setShowReviewForm] = useState(false)
  const [reviewKey, setReviewKey] = useState(0)

  useEffect(() => {
    setReviews(initialReviews ?? [])
    setShowReviewForm(false)
    if (initialReviews === undefined) {
      fetchUserReviews({ data: { parkingLotId: lotId } })
        .then(setReviews)
        .catch(() => setReviews([]))
    }
  }, [lotId, initialReviews])

  const refreshReviews = () => {
    fetchUserReviews({ data: { parkingLotId: lotId } })
      .then(setReviews)
      .catch(() => setReviews([]))
    onRefreshCount?.()
    setShowReviewForm(false)
    setReviewKey((key) => key + 1)
  }

  const visibleReviews = reviews.slice(0, CAROUSEL_LIMIT)
  const hasMore = reviews.length > CAROUSEL_LIMIT || count > CAROUSEL_LIMIT

  return (
    <section className={className}>
      {showTitle && (
        <SectionTitle
          title="리뷰"
          count={count}
          viewAll={hasMore && viewAllSlug ? { slug: viewAllSlug, tab: 'reviews' } : undefined}
        />
      )}

      {!showReviewForm && (
        <div className="mb-2.5 flex justify-end">
          <button
            type="button"
            onClick={() => setShowReviewForm(true)}
            className="flex cursor-pointer items-center gap-1 text-sm font-medium text-blue-500 hover:text-blue-600"
          >
            <Pen className="size-3" />
            리뷰 쓰기
          </button>
        </div>
      )}

      {showReviewForm && (
        <div className="mb-3">
          <ReviewForm key={reviewKey} parkingLotId={lotId} onSubmitted={refreshReviews} />
          <button
            type="button"
            onClick={() => setShowReviewForm(false)}
            className="mt-2 w-full cursor-pointer text-sm text-muted-foreground hover:text-foreground"
          >
            취소
          </button>
        </div>
      )}

      {visibleReviews.length > 0 ? (
        <Carousel>
          {visibleReviews.map((review) => (
            <CarouselSlide key={review.id} size="review">
              <UserReviewCard
                review={review}
                lotId={lotId}
                onDelete={
                  review.isMine
                    ? () => {
                        deleteReview({ data: { reviewId: review.id } })
                          .then(refreshReviews)
                          .catch(() => {})
                      }
                    : undefined
                }
              />
            </CarouselSlide>
          ))}
        </Carousel>
      ) : (
        !showReviewForm && (
          <p className="py-6 text-center text-xs text-muted-foreground">
            아직 리뷰가 없습니다. 첫 리뷰를 남겨보세요!
          </p>
        )
      )}
    </section>
  )
}
