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
    const title = `${lot.name} - 주차 난이도/요금/정보 | 쉬운주차장`
    const desc = `${lot.name} (${lot.address}) 주차 난이도 ${lot.difficulty.score ? lot.difficulty.score.toFixed(1) : '정보없음'}, ${lot.pricing.isFree ? '무료' : `기본 ${lot.pricing.baseTime}분 ${lot.pricing.baseFee.toLocaleString()}원`}. 리뷰 ${lot.difficulty.reviewCount}개.`
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': ['LocalBusiness', 'ParkingFacility'],
      name: lot.name,
      address: {
        '@type': 'PostalAddress',
        streetAddress: lot.address,
        addressCountry: 'KR',
      },
      geo: {
        '@type': 'GeoCoordinates',
        latitude: lot.lat,
        longitude: lot.lng,
      },
      url: `https://easy-parking.xyz/wiki/${slug}`,
      ...(lot.totalSpaces > 0 && { maximumAttendeeCapacity: lot.totalSpaces }),
      ...(lot.phone && { telephone: lot.phone }),
      ...(lot.pricing.isFree
        ? { isAccessibleForFree: true }
        : {
            isAccessibleForFree: false,
            priceRange: `기본 ${lot.pricing.baseTime}분 ${lot.pricing.baseFee.toLocaleString()}원`,
          }),
      ...(lot.difficulty.score !== null && {
        aggregateRating: {
          '@type': 'AggregateRating',
          ratingValue: lot.difficulty.score.toFixed(1),
          bestRating: '5',
          worstRating: '1',
          ratingCount: lot.difficulty.reviewCount || 1,
        },
      }),
    }

    return {
      meta: [
        { title },
        { name: 'description', content: desc },
        { name: 'robots', content: robotsContent },
        { property: 'og:title', content: title },
        { property: 'og:description', content: desc },
        { property: 'og:type', content: 'article' },
        {
          property: 'og:url',
          content: `https://easy-parking.xyz/wiki/${slug}`,
        },
      ],
      links: [{ rel: 'canonical', href: `https://easy-parking.xyz/wiki/${slug}` }],
      scripts: [
        {
          type: 'application/ld+json',
          children: JSON.stringify(jsonLd),
        },
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
