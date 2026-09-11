import { createFileRoute, Link, notFound, Outlet, redirect } from '@tanstack/react-router'
import { DEFAULT_FIELD_SOURCES, stripUnverifiedEdits } from '@/lib/lot-field-groups'
import { formatPricing } from '@/lib/parking-display'
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
  resolveLotRedirect,
} from '@/server/parking'
import { fetchUserReviews } from '@/server/reviews'

export const Route = createFileRoute('/wiki/$slug')({
  loader: async ({ params }) => {
    const id = parseIdFromSlug(params.slug)
    if (!id) throw notFound()
    const lot = await fetchParkingDetail({ data: { id } })
    if (!lot) {
      // 중복 병합으로 흡수된 lot 이면 남은 주차장으로 영구 이동 (A-4)
      const target = await resolveLotRedirect({ data: { id } })
      if (target) {
        throw redirect({
          to: '/wiki/$slug',
          params: { slug: makeParkingSlug(target.name, target.id) },
          statusCode: 301,
        })
      }
      throw notFound()
    }
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
    // 색인 판정도 확인 안 된 제보는 빼고 센다 — 유저가 채운 값 하나로 thin 페이지가
    // sitemap 에 들어가면, 구글이 보는 내용과 우리가 근거로 삼은 내용이 어긋난다
    const shouldIndex = shouldIndexParkingDetail(
      stripUnverifiedEdits(lot, lot.fieldSources ?? DEFAULT_FIELD_SOURCES),
      tabCounts,
    )
    const robotsContent = shouldIndex
      ? 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1'
      : 'noindex, follow, max-image-preview:large'
    const slug = makeParkingSlug(lot.name, lot.id)
    const canonicalUrl = `https://easy-parking.xyz/wiki/${encodeURI(slug)}`
    const title = `${lot.name} - 주차 난이도/요금/정보 | 쉬운주차장`
    // 요금 표기는 `formatPricing` 하나만 쓴다. 여기서 문자열을 따로 만들던 탓에
    // 요금표가 없는 곳(2026-09-04 실측 1,807곳)에 **"기본 0분 0원"** 이 나갔다.
    // 공짜처럼 읽히는 문구가 검색 결과 설명에 그대로 노출됐고, 화면은 같은 곳을
    // "정보 없음"으로 그리고 있어 둘이 어긋나 있었다.
    // (기본요금 0원은 정보 없음이 아니라 "최초 N분 무료" 정책이다 — 백화점·마트 등.)
    const pricing = formatPricing(lot.pricing)
    // 모르는 값은 설명에서 뺀다. 화면은 칸을 비우지 않고 "정보 없음"을 남기지만,
    // 검색 결과 설명은 길이가 한정돼 있어 없는 정보를 적을 자리가 아깝다.
    const pricingDesc = pricing.isUnknown ? null : pricing.primary
    const scoreDesc = lot.difficulty.score ? lot.difficulty.score.toFixed(1) : '정보없음'
    const curationPrefix =
      lot.curationTag === 'hell'
        ? '헬난이도 주차장. '
        : lot.curationTag === 'easy'
          ? '초보 추천 주차장. '
          : ''
    const desc = `${curationPrefix}${lot.name} (${lot.address}) 주차 난이도 ${scoreDesc}${
      pricingDesc ? `, ${pricingDesc}` : ''
    }. 리뷰 ${lot.difficulty.reviewCount}개.`

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
