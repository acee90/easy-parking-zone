import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ChevronLeft } from 'lucide-react'
import { useState } from 'react'
import { UserReviewCard } from '@/components/parking-reputation/UserReviewCard'
import { makeParkingSlug, parseIdFromSlug } from '@/lib/slug'
import { fetchParkingDetail } from '@/server/parking'
import { deleteReview, fetchUserReviews } from '@/server/reviews'
import type { UserReview } from '@/types/parking'

export const Route = createFileRoute('/wiki/$slug/reviews')({
  loader: async ({ params }) => {
    const id = parseIdFromSlug(params.slug)
    if (!id) throw notFound()
    const [lot, reviews] = await Promise.all([
      fetchParkingDetail({ data: { id } }),
      fetchUserReviews({ data: { parkingLotId: id, limit: 100 } }),
    ])
    if (!lot) throw notFound()
    return { lot, reviews }
  },
  head: ({ loaderData }) => {
    const lot = loaderData?.lot
    if (!lot) return {}
    const slug = makeParkingSlug(lot.name, lot.id)
    return {
      meta: [
        { title: `${lot.name} 사용자 리뷰 | 쉬운주차장` },
        { name: 'robots', content: 'noindex, follow' },
      ],
      links: [{ rel: 'canonical', href: `https://easy-parking.xyz/wiki/${slug}` }],
    }
  },
  component: ReviewsListPage,
})

function ReviewsListPage() {
  const { lot, reviews: initialReviews } = Route.useLoaderData()
  const [reviews, setReviews] = useState<UserReview[]>(initialReviews)
  const slug = makeParkingSlug(lot.name, lot.id)

  const handleDelete = (reviewId: number) => {
    deleteReview({ data: { reviewId } })
      .then(() => fetchUserReviews({ data: { parkingLotId: lot.id, limit: 100 } }))
      .then(setReviews)
      .catch(() => {})
  }

  return (
    <div className="min-h-screen bg-white">
      <header className="sticky top-0 z-10 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <Link
            to="/wiki/$slug"
            params={{ slug }}
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            aria-label="주차장 상세로 돌아가기"
          >
            <ChevronLeft className="size-4" />
            돌아가기
          </Link>
        </div>
      </header>
      <div className="mx-auto max-w-3xl px-4 py-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold">{lot.name}</h1>
          <p className="mt-1 text-sm text-muted-foreground">사용자 리뷰 {reviews.length}건</p>
        </div>
        {reviews.length > 0 ? (
          <div className="space-y-3">
            {reviews.map((review) => (
              <UserReviewCard
                key={review.id}
                review={review}
                lotId={lot.id}
                onDelete={review.isMine ? () => handleDelete(review.id) : undefined}
              />
            ))}
          </div>
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">아직 리뷰가 없습니다</p>
        )}
      </div>
    </div>
  )
}
