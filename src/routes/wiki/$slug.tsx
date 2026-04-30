import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import {
  ChevronRight,
  Clock,
  CreditCard,
  Flame,
  MapPin,
  MessageSquare,
  ParkingSquare,
  Phone,
  Star,
  Tag,
  ThumbsUp,
} from 'lucide-react'
import { NavigationButton } from '@/components/NavigationButton'
import { ParkingReputationSections } from '@/components/ParkingReputationSections'
import { UpcomingSection } from '@/components/parking-reputation/UpcomingSection'
import { Badge } from '@/components/ui/badge'
import { VoteBookmarkBar } from '@/components/VoteBookmarkBar'
import { WikiMiniMap } from '@/components/WikiMiniMap'
import { getDifficultyLabel, getReliabilityBadge } from '@/lib/geo-utils'
import {
  formatOperatingHours,
  formatPhone,
  formatPricing,
  formatTotalSpaces,
} from '@/lib/parking-display'
import { makeParkingSlug, parseIdFromSlug } from '@/lib/slug'
import {
  fetchBlogPosts,
  fetchNearbyPlaces,
  fetchParkingDetail,
  fetchParkingMedia,
  fetchTabCounts,
} from '@/server/parking'
import { fetchUserReviews } from '@/server/reviews'
import type { NearbyPlaceInfo } from '@/types/parking'

export const Route = createFileRoute('/wiki/$slug')({
  loader: async ({ params }) => {
    const id = parseIdFromSlug(params.slug)
    if (!id) throw notFound()
    const [lot, nearbyPlaces, blogPosts, media, reviews, tabCounts] = await Promise.all([
      fetchParkingDetail({ data: { id } }),
      fetchNearbyPlaces({ data: { parkingLotId: id } }),
      fetchBlogPosts({ data: { parkingLotId: id, limit: 7 } }),
      fetchParkingMedia({ data: { parkingLotId: id, limit: 7 } }),
      fetchUserReviews({ data: { parkingLotId: id, limit: 7 } }),
      fetchTabCounts({ data: { parkingLotId: id } }),
    ])
    if (!lot) throw notFound()
    return { lot, nearbyPlaces, blogPosts, media, reviews, tabCounts }
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
          <h2 className="text-xl font-bold">여기 주차하고 가볼 곳</h2>
          <Badge variant="secondary" className="text-xs">
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
                  <span className="truncate text-base font-semibold">{place.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{meta.label}</span>
                </div>
                {place.tip && (
                  <p className="mt-0.5 text-sm leading-relaxed text-muted-foreground">
                    {place.tip}
                  </p>
                )}
                <p className="mt-0.5 text-xs text-muted-foreground">
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
  const { lot, nearbyPlaces, blogPosts, media, reviews, tabCounts } = Route.useLoaderData()
  const score = lot.difficulty.score
  const scoreLabel = getDifficultyLabel(score)
  const reliabilityBadge = getReliabilityBadge(lot.difficulty.reliability)
  const sourceCount = tabCounts.reviews + tabCounts.blog + tabCounts.media
  const summary = lot.curationReason ?? lot.aiSummary
  const operatingHours = formatOperatingHours(lot.operatingHours)
  const pricing = formatPricing(lot.pricing)
  const totalSpacesLabel = formatTotalSpaces(lot.totalSpaces)
  const phoneLabel = formatPhone(lot.phone)
  const slug = makeParkingSlug(lot.name, lot.id)

  return (
    <div className="min-h-screen bg-white">
      <section className="relative border-b bg-white">
        <div className="relative mx-auto grid max-w-6xl grid-cols-1 gap-5 px-4 py-4 md:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)] md:py-6">
          <WikiMiniMap lat={lot.lat} lng={lot.lng} name={lot.name} />

          <div className="flex flex-col justify-between gap-5">
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={lot.pricing.isFree ? 'default' : 'outline'}>
                    {lot.pricing.isFree ? '무료' : '유료'}
                  </Badge>
                  <Badge variant="outline">{lot.type}</Badge>
                  {lot.difficulty.score !== null && lot.difficulty.score >= 4.0 && (
                    <Badge className="gap-1 bg-green-100 text-green-700 hover:bg-green-100">
                      <ThumbsUp className="size-3" />
                      초보 추천
                    </Badge>
                  )}
                  {lot.difficulty.score !== null && lot.difficulty.score < 2.0 && (
                    <Badge variant="destructive" className="gap-1">
                      <Flame className="size-3" />
                      초보 주의
                    </Badge>
                  )}
                </div>
                <h1 className="text-3xl font-bold leading-tight tracking-normal md:text-4xl">
                  {lot.name}
                </h1>
                <div className="flex items-start gap-2 text-sm text-muted-foreground">
                  <MapPin className="mt-0.5 size-4 shrink-0" />
                  <span>{lot.address}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-lg border bg-white p-4">
                  <div className="text-xs font-medium text-muted-foreground">쉬움 점수</div>
                  <div className="mt-2 flex items-end gap-2">
                    <span className="text-4xl font-black leading-none">
                      {score === null ? '-' : score.toFixed(1)}
                    </span>
                    <span className="pb-1 text-sm font-semibold text-muted-foreground">/ 5</span>
                  </div>
                  <div className="mt-2 flex items-center gap-1.5 text-sm font-medium">
                    <div className="flex items-center gap-0.5">
                      {[1, 2, 3, 4, 5].map((i) => (
                        <Star
                          key={i}
                          className={`size-3.5 ${
                            i <= Math.round(score ?? 0)
                              ? 'fill-yellow-400 text-yellow-400'
                              : 'text-gray-300'
                          }`}
                        />
                      ))}
                    </div>
                    <span>{scoreLabel}</span>
                  </div>
                </div>

                <div className="rounded-lg border bg-white p-4">
                  <div className="text-xs font-medium text-muted-foreground">평판 근거</div>
                  <div className="mt-2 text-4xl font-black leading-none">{sourceCount}</div>
                  <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
                    <MessageSquare className="size-3.5" />
                    리뷰/영상/웹 글
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <NavigationButton
                  lat={lot.lat}
                  lng={lot.lng}
                  name={lot.name}
                  buttonClassName="px-4 py-2 text-sm"
                />
                <VoteBookmarkBar lotId={lot.id} />
                {lot.phone && (
                  <a
                    href={`tel:${lot.phone}`}
                    className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition-colors hover:bg-zinc-50"
                  >
                    <Phone className="size-3.5" />
                    전화
                  </a>
                )}
              </div>
              {reliabilityBadge && (
                <Badge variant="outline" className={reliabilityBadge.className}>
                  {reliabilityBadge.label}
                </Badge>
              )}
            </div>
          </div>
        </div>
        <Link
          to="/"
          className="absolute left-4 top-4 rounded-lg bg-white/90 p-2 shadow-sm transition-colors hover:bg-white"
          aria-label="지도로 돌아가기"
        >
          <ChevronRight className="size-5 rotate-180" />
        </Link>
      </section>

      {/* 컨텐츠 */}
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-2 space-y-4">
            {summary && (
              <section className="rounded-xl border border-blue-100 bg-blue-50 p-5">
                <div className="mb-2 text-xs font-semibold text-blue-700">AI 요약</div>
                <p className="whitespace-pre-line text-base font-medium leading-relaxed text-zinc-900">
                  {summary}
                </p>
              </section>
            )}

            {/* AI 팁 */}
            {(lot.aiTipPricing || lot.aiTipVisit || lot.aiTipAlternative) && (
              <section className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {lot.aiTipPricing && (
                  <div className="rounded-lg border bg-white px-4 py-3 text-sm leading-relaxed text-gray-700">
                    <span className="mb-1 block text-base font-semibold text-gray-900">요금</span>
                    {lot.aiTipPricing}
                  </div>
                )}
                {lot.aiTipVisit && (
                  <div className="rounded-lg border bg-white px-4 py-3 text-sm leading-relaxed text-gray-700">
                    <span className="mb-1 block text-base font-semibold text-gray-900">
                      방문 팁
                    </span>
                    {lot.aiTipVisit}
                  </div>
                )}
                {lot.aiTipAlternative && (
                  <div className="rounded-lg border bg-white px-4 py-3 text-sm leading-relaxed text-gray-700">
                    <span className="mb-1 block text-base font-semibold text-gray-900">대안</span>
                    {lot.aiTipAlternative}
                  </div>
                )}
              </section>
            )}

            {/* 기본 정보 */}
            <section className="border-t-2 border-zinc-300 pt-7 pb-8">
              <h2 className="mb-4 text-xl font-bold">주차장 정보</h2>
              <div className="space-y-3 text-sm">
                {/* 주소 */}
                <div className="flex items-start gap-2.5">
                  <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span>{lot.address}</span>
                </div>

                {/* 운영시간 */}
                <div className="flex items-start gap-2.5">
                  <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <div className={operatingHours.isUnknown ? 'text-muted-foreground' : ''}>
                      {operatingHours.primary}
                    </div>
                    {operatingHours.secondary && (
                      <div className="text-xs text-muted-foreground">
                        {operatingHours.secondary}
                      </div>
                    )}
                  </div>
                </div>

                {/* 요금 */}
                <div className="flex items-start gap-2.5">
                  <CreditCard className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <div className={pricing.isUnknown ? 'text-muted-foreground' : ''}>
                      {pricing.primary}
                    </div>
                    {pricing.secondary && (
                      <div className="text-xs text-muted-foreground">{pricing.secondary}</div>
                    )}
                  </div>
                </div>

                {totalSpacesLabel && (
                  <div className="flex items-center gap-2.5">
                    <ParkingSquare className="size-4 shrink-0 text-muted-foreground" />
                    <span>{totalSpacesLabel}</span>
                  </div>
                )}

                {/* 전화번호 */}
                {phoneLabel && (
                  <div className="flex items-center gap-2.5">
                    <Phone className="size-4 shrink-0 text-muted-foreground" />
                    <a href={`tel:${phoneLabel}`} className="text-blue-500 underline">
                      {phoneLabel}
                    </a>
                  </div>
                )}

                {/* POI 태그 */}
                {lot.poiTags && lot.poiTags.length > 0 && (
                  <div className="flex items-start gap-2.5">
                    <Tag className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    <div className="flex flex-wrap gap-1.5">
                      {lot.poiTags.map((tag) => (
                        <Badge key={tag} variant="outline" className="text-xs">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* 리뷰/블로그/영상 섹션 (loader에서 prefetch → SSR로 봇 노출) */}
            <section className="pt-2">
              <ParkingReputationSections
                lotId={lot.id}
                expanded
                initialBlogPosts={blogPosts}
                initialMedia={media}
                initialReviews={reviews}
                initialTabCounts={tabCounts}
                viewAllSlug={slug}
              />
            </section>
          </div>

          <div className="space-y-4">
            {/* 주변 갈만한 곳 */}
            {nearbyPlaces.length > 0 ? (
              <NearbyPlacesSection places={nearbyPlaces} />
            ) : (
              <UpcomingSection
                title="여기 주차하고 가볼 곳"
                description="주변 명소 정보가 곧 추가됩니다"
              />
            )}
            <UpcomingSection
              title="비슷한 주차장"
              description="유사 난이도 주차장 추천이 곧 추가됩니다"
            />
          </div>
        </div>
      </div>
    </div>
  )
}
