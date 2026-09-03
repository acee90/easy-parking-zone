import { createFileRoute, Link, notFound, Outlet } from '@tanstack/react-router'
import { shouldIndexParkingDetail } from '@/lib/seo-indexing'
import { makeParkingSlug, parseIdFromSlug } from '@/lib/slug'
import { fetchDestinationsForLot } from '@/server/destinations'
import {
  fetchAlternativeLots,
  fetchNearbyPlaces,
  fetchParkingDetail,
  fetchRelatedParkingLots,
  fetchTabCounts,
  fetchWebSentiment,
  fetchWebSourceRefs,
} from '@/server/parking'
import { fetchUserReviews } from '@/server/reviews'

export const Route = createFileRoute('/wiki/$slug')({
  loader: async ({ params }) => {
    const id = parseIdFromSlug(params.slug)
    if (!id) throw notFound()
    const lot = await fetchParkingDetail({ data: { id } })
    if (!lot) throw notFound()
    const [
      nearbyPlaces,
      reviews,
      tabCounts,
      relatedLots,
      webSentiment,
      webSources,
      alternativeLots,
      destinations,
    ] = await Promise.all([
      fetchNearbyPlaces({ data: { parkingLotId: id } }),
      // 블로그·영상은 더 이상 상세페이지에 없다 (하위 라우트도 삭제).
      // 지도 패널·카드가 필요할 때 스스로 불러오므로 여기서 미리 조회하지 않는다 —
      // 상세페이지 1회당 D1 조회 2건이 줄어든다.
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
      // 웹 후기 분위기 + 자주 나온 말 (2-1 / 2-2)
      fetchWebSentiment({ data: { parkingLotId: id } }),
      // 참고한 웹 글 — 제목·도메인·날짜·링크만 (2-4)
      fetchWebSourceRefs({ data: { parkingLotId: id } }),
      // 후기에서 함께 언급된 주차장 (3-1)
      fetchAlternativeLots({ data: { parkingLotId: id } }),
      // 이 주차장이 속한 목적지 페이지 (#166). 발행된 목적지가 없으면 빈 배열
      // 테이블이 아직 없는 환경(마이그레이션 전)에서도 상세페이지가 죽으면 안 된다 — 블록만 비운다
      fetchDestinationsForLot({ data: { parkingLotId: id } }).catch(() => []),
    ])
    return {
      lot,
      nearbyPlaces,
      reviews,
      tabCounts,
      relatedLots,
      webSentiment,
      webSources,
      alternativeLots,
      destinations,
    }
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
      <Link to="/" className="text-primary underline">
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
