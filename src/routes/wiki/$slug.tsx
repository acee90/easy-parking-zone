import { createFileRoute, Link, notFound, Outlet } from '@tanstack/react-router'
import { shouldIndexParkingDetail } from '@/lib/seo-indexing'
import { makeParkingSlug, parseIdFromSlug } from '@/lib/slug'
import {
  fetchBlogPosts,
  fetchNearbyPlaces,
  fetchParkingDetail,
  fetchParkingMedia,
  fetchRelatedParkingLots,
  fetchTabCounts,
} from '@/server/parking'
import { fetchUserReviews } from '@/server/reviews'

export const Route = createFileRoute('/wiki/$slug')({
  loader: async ({ params }) => {
    const id = parseIdFromSlug(params.slug)
    if (!id) throw notFound()
    const lot = await fetchParkingDetail({ data: { id } })
    if (!lot) throw notFound()
    const [nearbyPlaces, blogPosts, media, reviews, tabCounts, relatedLots] = await Promise.all([
      fetchNearbyPlaces({ data: { parkingLotId: id } }),
      fetchBlogPosts({ data: { parkingLotId: id, limit: 7 } }),
      fetchParkingMedia({ data: { parkingLotId: id, limit: 7 } }),
      fetchUserReviews({ data: { parkingLotId: id, limit: 7 } }),
      fetchTabCounts({ data: { parkingLotId: id } }),
      fetchRelatedParkingLots({
        data: {
          lat: lot.lat,
          lng: lot.lng,
          address: lot.address,
          excludeId: lot.id,
          limit: 8,
        },
      }),
    ])
    return { lot, nearbyPlaces, blogPosts, media, reviews, tabCounts, relatedLots }
  },
  head: ({ loaderData }) => {
    const lot = loaderData?.lot
    if (!lot) return {}
    const tabCounts = loaderData?.tabCounts
    const shouldIndex = shouldIndexParkingDetail(lot, tabCounts)
    const robotsContent = shouldIndex
      ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
      : 'noindex, follow, max-image-preview:large'
    const slug = makeParkingSlug(lot.name, lot.id)
    const canonicalUrl = `https://easy-parking.xyz/wiki/${encodeURI(slug)}`
    const title = `${lot.name} - 주차 난이도/요금/정보 | 쉬운주차장`
    const pricingDesc = lot.pricing.isFree
      ? '무료'
      : `기본 ${lot.pricing.baseTime}분 ${lot.pricing.baseFee.toLocaleString()}원`
    const scoreDesc = lot.difficulty.score ? lot.difficulty.score.toFixed(1) : '정보없음'
    const curationPrefix =
      lot.curationTag === 'hell'
        ? '헬난이도 주차장. '
        : lot.curationTag === 'easy'
          ? '초보 추천 주차장. '
          : ''
    const desc = `${curationPrefix}${lot.name} (${lot.address}) 주차 난이도 ${scoreDesc}, ${pricingDesc}. 리뷰 ${lot.difficulty.reviewCount}개.`

    // canonical/JSON-LD는 TanStack Start head API의 links/scripts가 SSR HTML에
    // 직렬화되지 않아 $slug.index.tsx에서 React 19 metadata hoisting으로 직접 렌더한다.
    return {
      meta: [
        { title },
        { name: 'description', content: desc },
        { name: 'robots', content: robotsContent },
        { property: 'og:title', content: title },
        { property: 'og:description', content: desc },
        { property: 'og:type', content: 'article' },
        { property: 'og:url', content: canonicalUrl },
      ],
    }
  },
  notFoundComponent: () => (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-bold">주차장을 찾을 수 없습니다</h1>
      <Link to="/" className="text-blue-500 underline">
        지도로 돌아가기
      </Link>
    </div>
  ),
  component: WikiDetailPageLayout,
})

function WikiDetailPageLayout() {
  return (
    <div className="min-h-screen bg-white">
      <Outlet />
    </div>
  )
}
