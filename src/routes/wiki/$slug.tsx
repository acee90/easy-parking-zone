import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import {
  ChevronRight,
  Clock,
  CreditCard,
  ExternalLink,
  Flame,
  Map as MapIcon,
  MapPin,
  ParkingSquare,
  Phone,
  Tag,
  ThumbsUp,
} from 'lucide-react'
import { ParkingTabs } from '@/components/ParkingTabs'
import { Badge } from '@/components/ui/badge'
import { VoteBookmarkBar } from '@/components/VoteBookmarkBar'
import { WikiMiniMap } from '@/components/WikiMiniMap'
import {
  getDifficultyColor,
  getDifficultyIcon,
  getDifficultyLabel,
  getReliabilityBadge,
} from '@/lib/geo-utils'
import { makeParkingSlug, parseIdFromSlug } from '@/lib/slug'
import { fetchParkingDetail } from '@/server/parking'

export const Route = createFileRoute('/wiki/$slug')({
  loader: async ({ params }) => {
    const id = parseIdFromSlug(params.slug)
    if (!id) throw notFound()
    const lot = await fetchParkingDetail({ data: { id } })
    if (!lot) throw notFound()
    return { lot }
  },
  head: ({ loaderData }) => {
    const lot = loaderData?.lot
    if (!lot) return {}
    const slug = makeParkingSlug(lot.name, lot.id)
    const title = `${lot.name} - 주차 난이도/요금/정보 | 쉬운주차장`
    const desc = `${lot.name} (${lot.address}) 주차 난이도 ${getDifficultyLabel(lot.difficulty.score)}, ${lot.pricing.isFree ? '무료' : `기본 ${lot.pricing.baseTime}분 ${lot.pricing.baseFee.toLocaleString()}원`}. 리뷰 ${lot.difficulty.reviewCount}개.`
    const jsonLd = {
      '@context': 'https://schema.org',
      '@type': 'ParkingFacility',
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
        { property: 'og:title', content: title },
        { property: 'og:description', content: desc },
        { property: 'og:type', content: 'article' },
        {
          property: 'og:url',
          content: `https://easy-parking.xyz/wiki/${slug}`,
        },
      ],
      headScripts: [
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
  component: WikiDetailPage,
})

function WikiDetailPage() {
  const { lot } = Route.useLoaderData()

  const icon = getDifficultyIcon(lot.difficulty.score)
  const label = getDifficultyLabel(lot.difficulty.score)
  const reliabilityBadge = getReliabilityBadge(lot.difficulty.reliability)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* 브레드크럼 */}
      <div className="bg-white border-b">
        <div className="max-w-3xl mx-auto px-4 py-2 text-xs text-muted-foreground flex items-center gap-1">
          <Link to="/" className="hover:text-foreground transition-colors">
            지도
          </Link>
          <ChevronRight className="size-3" />
          <Link to="/wiki" className="hover:text-foreground transition-colors">
            위키
          </Link>
          <ChevronRight className="size-3" />
          <span className="text-foreground truncate">{lot.name}</span>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
        {/* 헤더 */}
        <header className="space-y-3">
          <div className="flex items-start gap-3">
            <div
              className={`size-4 rounded-full shrink-0 mt-1.5 ${getDifficultyColor(lot.difficulty.score)}`}
            />
            <h1 className="text-2xl font-bold leading-tight">{lot.name}</h1>
          </div>

          {/* 배지 */}
          <div className="flex items-center gap-2 flex-wrap">
            {lot.difficulty.score !== null && lot.difficulty.score < 2.0 && (
              <Badge variant="destructive" className="text-xs gap-1">
                <Flame className="size-3" />
                초보 주의
              </Badge>
            )}
            {lot.difficulty.score !== null && lot.difficulty.score >= 4.0 && (
              <Badge className="text-xs gap-1 bg-green-500 hover:bg-green-600">
                <ThumbsUp className="size-3" />
                초보 추천
              </Badge>
            )}
            <Badge variant="secondary" className="text-sm">
              {icon} {label}
            </Badge>
            {reliabilityBadge && (
              <Badge variant="outline" className={`text-xs ${reliabilityBadge.className}`}>
                {reliabilityBadge.label}
              </Badge>
            )}
            <Badge variant={lot.pricing.isFree ? 'default' : 'outline'}>
              {lot.pricing.isFree ? '무료' : '유료'}
            </Badge>
            {lot.type && (
              <Badge variant="outline" className="text-xs">
                {lot.type}
              </Badge>
            )}
          </div>

          {/* 액션 바 */}
          <div className="flex items-center gap-2">
            <a
              href={`https://map.naver.com/v5/directions/-/${lot.lng},${lot.lat},${encodeURIComponent(lot.name)}/-/transit?c=${lot.lng},${lot.lat},15,0,0,0,dh`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-green-500 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-600 transition-colors"
            >
              <ExternalLink className="size-3" />
              길찾기
            </a>
            <Link
              to="/"
              search={{ lotId: lot.id }}
              className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-gray-100 transition-colors"
            >
              <MapIcon className="size-3" />
              지도에서 보기
            </Link>
            <VoteBookmarkBar lotId={lot.id} />
          </div>
        </header>

        {/* 큐레이션 사유 */}
        {lot.curationReason && (
          <div
            className={`text-sm rounded-lg px-4 py-3 ${
              lot.difficulty.score !== null && lot.difficulty.score < 2.0
                ? 'bg-red-50 text-red-700'
                : 'bg-green-50 text-green-700'
            }`}
          >
            {lot.difficulty.score !== null && lot.difficulty.score < 2.0 ? '⚠️' : '✅'}{' '}
            {lot.curationReason}
            {lot.featuredSource === '1010' && (
              <span className="block mt-1 text-xs opacity-75">
                📺 10시10분 유튜브에 소개된 주차장
              </span>
            )}
          </div>
        )}

        {/* 기본 정보 카드 */}
        <section className="bg-white rounded-xl border p-5 space-y-4">
          <h2 className="font-semibold text-base">기본 정보</h2>

          <div className="grid gap-3">
            <div className="flex items-start gap-2.5 text-sm">
              <MapPin className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
              <span>{lot.address}</span>
            </div>

            <div className="flex items-start gap-2.5 text-sm">
              <Clock className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
              <div>
                <div>
                  평일 {lot.operatingHours.weekday.start}-{lot.operatingHours.weekday.end}
                </div>
                <div className="text-xs text-muted-foreground">
                  토 {lot.operatingHours.saturday.start}-{lot.operatingHours.saturday.end} · 공휴일{' '}
                  {lot.operatingHours.holiday.start}-{lot.operatingHours.holiday.end}
                </div>
              </div>
            </div>

            {!lot.pricing.isFree && (
              <div className="flex items-start gap-2.5 text-sm">
                <CreditCard className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                <div>
                  <div>
                    기본 {lot.pricing.baseTime}분 {lot.pricing.baseFee.toLocaleString()}원
                  </div>
                  <div className="text-xs text-muted-foreground">
                    추가 {lot.pricing.extraTime}분당 {lot.pricing.extraFee.toLocaleString()}원
                    {lot.pricing.dailyMax &&
                      ` · 1일 최대 ${lot.pricing.dailyMax.toLocaleString()}원`}
                    {lot.pricing.monthlyPass &&
                      ` · 월정기 ${lot.pricing.monthlyPass.toLocaleString()}원`}
                  </div>
                </div>
              </div>
            )}
            {lot.pricing.isFree && (
              <div className="flex items-center gap-2.5 text-sm">
                <CreditCard className="size-4 shrink-0 text-muted-foreground" />
                <span className="text-green-600 font-medium">무료 주차장</span>
              </div>
            )}

            {lot.totalSpaces > 0 && (
              <div className="flex items-center gap-2.5 text-sm">
                <ParkingSquare className="size-4 shrink-0 text-muted-foreground" />
                <span>총 {lot.totalSpaces}면</span>
              </div>
            )}

            {lot.phone && (
              <div className="flex items-center gap-2.5 text-sm">
                <Phone className="size-4 shrink-0 text-muted-foreground" />
                <a href={`tel:${lot.phone}`} className="text-blue-500 underline">
                  {lot.phone}
                </a>
              </div>
            )}

            {lot.poiTags && lot.poiTags.length > 0 && (
              <div className="flex items-start gap-2.5 text-sm">
                <Tag className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                <div className="flex flex-wrap gap-1.5">
                  {lot.poiTags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {lot.notes && (
              <p className="text-xs text-muted-foreground bg-gray-50 rounded-lg px-3 py-2">
                {lot.notes}
              </p>
            )}
          </div>
        </section>

        {/* 미니 지도 */}
        <WikiMiniMap lat={lot.lat} lng={lot.lng} name={lot.name} />

        {/* 리뷰/블로그/영상 탭 */}
        <section className="bg-white rounded-xl border p-5">
          <ParkingTabs lotId={lot.id} expanded />
        </section>
      </div>
    </div>
  )
}
