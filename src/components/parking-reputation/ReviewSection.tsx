import { useEffect, useState } from 'react'
import { deleteReview, fetchUserReviews } from '@/server/reviews'
import type { UserReview } from '@/types/parking'
import { Carousel, CarouselSlide } from './Carousel'
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
  /** 외부에서 변경 시 다시 불러오기 위한 트리거 (WriteReviewSection 제출 후 증가) */
  refreshKey?: number
}

export function ReviewSection({
  lotId,
  count,
  initialReviews,
  showTitle = true,
  className,
  onRefreshCount,
  viewAllSlug,
  refreshKey = 0,
}: ReviewSectionProps) {
  const [reviews, setReviews] = useState<UserReview[]>(initialReviews ?? [])

  useEffect(() => {
    if (refreshKey === 0 && initialReviews !== undefined) {
      setReviews(initialReviews)
      return
    }
    fetchUserReviews({ data: { parkingLotId: lotId } })
      .then(setReviews)
      .catch(() => setReviews([]))
  }, [lotId, initialReviews, refreshKey])

  const handleDelete = (reviewId: number) => {
    deleteReview({ data: { reviewId } })
      .then(() => fetchUserReviews({ data: { parkingLotId: lotId } }))
      .then((next) => {
        setReviews(next)
        onRefreshCount?.()
      })
      .catch(() => {})
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

      {visibleReviews.length > 0 ? (
        <Carousel>
          {visibleReviews.map((review) => (
            <CarouselSlide key={review.id} size="review">
              <UserReviewCard
                review={review}
                lotId={lotId}
                onDelete={review.isMine ? () => handleDelete(review.id) : undefined}
              />
            </CarouselSlide>
          ))}
        </Carousel>
      ) : (
        <p className="py-6 text-center text-xs text-muted-foreground">
          아직 리뷰가 없습니다. 첫 리뷰를 남겨보세요!
        </p>
      )}
    </section>
  )
}
