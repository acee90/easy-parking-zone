import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import {
  BadgeCheck,
  ChevronRight,
  Clock,
  CreditCard,
  ExternalLink,
  Flame,
  Map as MapIcon,
  MapPin,
  ParkingSquare,
  Phone,
  Star,
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
import { fetchNearbyPlaces, fetchParkingDetail } from '@/server/parking'
import type { NearbyPlaceInfo } from '@/types/parking'

export const Route = createFileRoute('/wiki/$slug')({
  loader: async ({ params }) => {
    const id = parseIdFromSlug(params.slug)
    if (!id) throw notFound()
    const [lot, nearbyPlaces] = await Promise.all([
      fetchParkingDetail({ data: { id } }),
      fetchNearbyPlaces({ data: { parkingLotId: id } }),
    ])
    if (!lot) throw notFound()
    return { lot, nearbyPlaces }
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
        {
          name: 'robots',
          content: 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
        },
        { property: 'og:title', content: title },
        { property: 'og:description', content: desc },
        { property: 'og:type', content: 'article' },
        {
          property: 'og:url',
          content: `https://easy-parking.xyz/wiki/${slug}`,
        },
      ],
      links: [{ rel: 'canonical', href: `https://easy-parking.xyz/wiki/${slug}` }],
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

function VerifiedBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 text-sm text-blue-600 font-medium">
      <BadgeCheck className="size-3.5" />
      검증됨
    </span>
  )
}

const CATEGORY_META: Record<string, { icon: string; label: string }> = {
  cafe: { icon: '☕', label: '카페' },
  restaurant: { icon: '🍽️', label: '맛집' },
  park: { icon: '🌳', label: '공원' },
  tourist: { icon: '🎫', label: '관광' },
  market: { icon: '🛒', label: '시장' },
  hospital: { icon: '🏥', label: '병원' },
  etc: { icon: '📍', label: '기타' },
}

function NearbyPlacesSection({ places }: { places: NearbyPlaceInfo[] }) {
  if (places.length === 0) return null

  return (
    <section className="bg-white rounded-xl border p-5 space-y-4">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <h2 className="font-semibold text-lg">여기 주차하고 가볼 곳</h2>
          <Badge variant="secondary" className="text-sm">
            {places.length}곳
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          자체 주차가 어려워 이 주차장을 이용하면 좋은 주변 장소
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {places.map((place) => {
          const meta = CATEGORY_META[place.category] ?? CATEGORY_META.etc
          return (
            <div
              key={place.id}
              className="flex items-start gap-3 rounded-lg border p-3 hover:bg-gray-50 transition-colors overflow-hidden"
            >
              {place.thumbnailUrl ? (
                <img
                  src={place.thumbnailUrl}
                  alt={place.name}
                  className="size-14 rounded-lg object-cover shrink-0"
                  loading="lazy"
                />
              ) : (
                <span className="size-14 rounded-lg bg-gray-100 flex items-center justify-center text-xl shrink-0">
                  {meta.icon}
                </span>
              )}
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-base truncate">{place.name}</span>
                  <span className="text-sm text-muted-foreground shrink-0">{meta.label}</span>
                </div>
                {place.tip && <p className="text-sm text-muted-foreground mt-0.5">{place.tip}</p>}
                <p className="text-sm text-muted-foreground mt-0.5">
                  {place.mentionCount}개 블로그에서 언급
                </p>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function WikiDetailPage() {
  const { lot, nearbyPlaces } = Route.useLoaderData()

  return (
    <div className="min-h-screen bg-white">
      {/* 히어로 이미지 */}
      <div className="relative h-48 bg-gradient-to-br from-blue-100 to-blue-50 flex items-center justify-center overflow-hidden">
        <div className="absolute inset-0 opacity-10 flex items-center justify-center">
          <ParkingSquare className="size-40 text-blue-500" />
        </div>
        <Link
          to="/"
          className="absolute top-4 left-4 p-2 rounded-lg bg-white/90 hover:bg-white shadow-sm transition-colors"
        >
          <ChevronRight className="size-5 rotate-180" />
        </Link>
      </div>

      {/* 컨텐츠 */}
      <div className="max-w-6xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* 좌측: 정보 + 탭 */}
          <div className="md:col-span-2 space-y-4">
            {/* 제목 */}
            <h1 className="text-3xl font-bold">{lot.name}</h1>

            {/* 평점 + 리뷰 수 */}
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1">
                <div className="flex items-center gap-0.5">
                  {[1, 2, 3, 4, 5].map((i) => {
                    const rating = lot.difficulty.score ?? 0
                    return (
                      <Star
                        key={i}
                        className={`size-4 ${
                          i <= Math.round(rating)
                            ? 'fill-yellow-400 text-yellow-400'
                            : 'text-gray-300'
                        }`}
                      />
                    )
                  })}
                </div>
                <span className="font-bold text-xl">{(lot.difficulty.score ?? 0).toFixed(1)}</span>
              </div>
              {lot.difficulty.reviewCount > 0 && (
                <span className="text-lg text-muted-foreground">
                  리뷰 {lot.difficulty.reviewCount}개
                </span>
              )}
            </div>

            {/* 상태 배지 */}
            <div className="flex items-center gap-2 flex-wrap">
              <Badge className="bg-green-500 hover:bg-green-600 text-white text-sm">
                주차 가능
              </Badge>
              <Badge variant={lot.pricing.isFree ? 'default' : 'outline'} className="text-sm">
                {lot.pricing.isFree ? '무료' : '유료'}
              </Badge>
              {lot.difficulty.score !== null && lot.difficulty.score >= 4.0 && (
                <Badge className="bg-green-100 text-green-700 hover:bg-green-100 gap-1 text-sm">
                  <ThumbsUp className="size-3" />
                  초보 추천
                </Badge>
              )}
              {lot.difficulty.score !== null && lot.difficulty.score < 2.0 && (
                <Badge variant="destructive" className="gap-1 text-sm">
                  <Flame className="size-3" />
                  초보 주의
                </Badge>
              )}
            </div>

            {/* 액션 버튼 */}
            <div className="flex gap-2 pt-2">
              <a
                href={`https://map.kakao.com/link/map/${lot.name},${lot.lat},${lot.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 rounded-lg bg-yellow-400 text-black font-medium py-3 text-base hover:bg-yellow-500 transition-colors text-center"
              >
                카카오맵
              </a>
              <a
                href={`https://map.naver.com/v5/directions/-/${lot.lng},${lot.lat},${encodeURIComponent(lot.name)}/-/transit?c=${lot.lng},${lot.lat},15,0,0,0,dh`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 rounded-lg bg-green-500 text-white font-medium py-3 text-base hover:bg-green-600 transition-colors text-center"
              >
                네이버맵
              </a>
            </div>

            {/* AI Summary */}
            {lot.curationReason && (
              <div
                className={`rounded-lg px-4 py-3.5 border space-y-2 ${
                  lot.difficulty.score !== null && lot.difficulty.score < 2.0
                    ? 'bg-red-50 border-red-200'
                    : 'bg-blue-50 border-blue-200'
                }`}
              >
                <div className="font-semibold text-base flex items-center gap-2">
                  {lot.difficulty.score !== null && lot.difficulty.score < 2.0 ? '⚠️' : '✨'} AI 요약
                </div>
                <p
                  className={`text-base ${
                    lot.difficulty.score !== null && lot.difficulty.score < 2.0
                      ? 'text-red-700'
                      : 'text-blue-700'
                  }`}
                >
                  {lot.curationReason}
                </p>
                {lot.featuredSource === '1010' && (
                  <p className="text-xs text-muted-foreground pt-2 border-t border-current border-opacity-20">
                    📺 10시10분 유튜브 채널에 소개된 주차장
                  </p>
                )}
              </div>
            )}

            {/* 기본 정보 */}
            <div className="space-y-3 text-base border-t pt-4">
              {/* 주소 */}
              <div className="flex items-start gap-2.5">
                <MapPin className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                <span>{lot.address}</span>
              </div>

              {/* 운영시간 */}
              <div className="flex items-start gap-2.5">
                <Clock className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                <div>
                  <div>
                    평일 {lot.operatingHours.weekday.start}-{lot.operatingHours.weekday.end}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    토 {lot.operatingHours.saturday.start}-{lot.operatingHours.saturday.end} ·
                    공휴일 {lot.operatingHours.holiday.start}-{lot.operatingHours.holiday.end}
                  </div>
                </div>
              </div>

              {/* 요금 */}
              {!lot.pricing.isFree && (
                <div className="flex items-start gap-2.5">
                  <CreditCard className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                  <div>
                    <div>
                      기본 {lot.pricing.baseTime}분 {lot.pricing.baseFee.toLocaleString()}원
                    </div>
                    <div className="text-sm text-muted-foreground">
                      추가 {lot.pricing.extraTime}분당 {lot.pricing.extraFee.toLocaleString()}원
                      {lot.pricing.dailyMax &&
                        ` · 1일 최대 ${lot.pricing.dailyMax.toLocaleString()}원`}
                    </div>
                  </div>
                </div>
              )}

              {/* 전화번호 */}
              {lot.phone && (
                <div className="flex items-center gap-2.5">
                  <Phone className="size-4 shrink-0 text-muted-foreground" />
                  <a href={`tel:${lot.phone}`} className="text-blue-500 underline">
                    {lot.phone}
                  </a>
                </div>
              )}

              {/* POI 태그 */}
              {lot.poiTags && lot.poiTags.length > 0 && (
                <div className="flex items-start gap-2.5">
                  <Tag className="size-4 shrink-0 mt-0.5 text-muted-foreground" />
                  <div className="flex flex-wrap gap-1.5">
                    {lot.poiTags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-sm">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 리뷰/블로그/영상 탭 */}
            <div className="pt-4">
              <ParkingTabs lotId={lot.id} expanded />
            </div>
          </div>

          {/* 우측: 지도 + 주변장소 */}
          <div className="space-y-4">
            {/* 미니 지도 */}
            <div className="sticky top-4">
              <WikiMiniMap lat={lot.lat} lng={lot.lng} name={lot.name} />
            </div>

            {/* 주변 갈만한 곳 */}
            {nearbyPlaces.length > 0 && <NearbyPlacesSection places={nearbyPlaces} />}
          </div>
        </div>
      </div>
    </div>
  )
}
