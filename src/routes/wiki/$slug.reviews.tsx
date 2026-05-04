import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { ChevronLeft, MessageSquare, Star } from 'lucide-react'
import { useState } from 'react'
import { StarDisplay } from '@/components/parking-reputation/StarDisplay'
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

  const avgScore = lot.difficulty.score

  return (
    <div className="min-h-screen bg-zinc-50/50">
      <header className="sticky top-0 z-10 border-b bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <Link
              to="/wiki/$slug"
              params={{ slug }}
              className="flex size-9 items-center justify-center rounded-full border bg-white text-zinc-600 transition-colors hover:bg-zinc-50 hover:text-zinc-900"
              aria-label="주차장 상세로 돌아가기"
            >
              <ChevronLeft className="size-5" />
            </Link>
            <div className="flex flex-col">
              <h1 className="text-base font-bold text-zinc-900 line-clamp-1">{lot.name}</h1>
              <p className="text-xs text-zinc-500">사용자 리뷰 {reviews.length}건</p>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-8">
        {/* 요약 섹션 */}
        <section className="mb-10 rounded-3xl border bg-white p-8 shadow-sm">
          <div className="flex flex-col items-center gap-6 text-center md:flex-row md:text-left">
            <div className="flex flex-col items-center gap-2 md:items-start md:border-r md:pr-10">
              <span className="text-sm font-bold text-zinc-500">쉬움 평균 점수</span>
              <div className="flex items-baseline gap-2">
                <span className="text-6xl font-black text-zinc-900">
                  {avgScore === null ? '-' : avgScore.toFixed(1)}
                </span>
                <span className="text-xl font-bold text-zinc-400">/ 5.0</span>
              </div>
              <div className="mt-1">
                <StarDisplay score={avgScore ?? 0} size="lg" />
              </div>
            </div>
            <div className="flex flex-1 flex-col gap-1">
              <div className="flex items-center gap-2 text-xl font-bold text-zinc-900">
                <MessageSquare className="size-6 text-blue-500" />
                <span>총 {reviews.length}개의 생생한 리뷰</span>
              </div>
              <p className="text-sm leading-relaxed text-zinc-500">
                실제 방문자들이 남긴 주차 난이도와 생생한 팁을 확인해보세요. 직접 방문하셨다면 다른
                분들을 위해 소중한 후기를 남겨주세요!
              </p>
            </div>
          </div>
        </section>

        {reviews.length > 0 ? (
          <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
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
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="mb-4 flex size-16 items-center justify-center rounded-full bg-zinc-100">
              <Star className="size-8 text-zinc-300" />
            </div>
            <p className="text-lg font-bold text-zinc-900">아직 리뷰가 없습니다</p>
            <p className="mt-1 text-sm text-zinc-500">첫 번째 리뷰의 주인공이 되어보세요!</p>
            <Link
              to="/wiki/$slug"
              params={{ slug }}
              className="mt-6 rounded-xl bg-blue-600 px-6 py-3 text-sm font-bold text-white shadow-lg shadow-blue-200 transition-transform hover:scale-105 active:scale-95"
            >
              리뷰 작성하러 가기
            </Link>
          </div>
        )}
      </main>
    </div>
  )
}
