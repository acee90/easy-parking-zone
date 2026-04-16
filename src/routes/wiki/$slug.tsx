import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { BadgeCheck, ChevronRight, ExternalLink, Map as MapIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { ParkingTabs } from '@/components/ParkingTabs'
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
    const title = `${lot.name} 주차 정보 | 쉽주`
    const pricingText = lot.pricing.isFree
      ? '무료 운영'
      : `기본 ${lot.pricing.baseTime}분 ${lot.pricing.baseFee.toLocaleString()}원`
    const desc = `${lot.address}에 있는 주차장. 난이도 ${getDifficultyLabel(lot.difficulty.score)}, ${pricingText}.${lot.difficulty.reviewCount > 0 ? ` 이용자 평가 ${lot.difficulty.reviewCount}건.` : ''}`
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
        { property: 'og:url', content: `https://easy-parking.xyz/wiki/${slug}` },
        { property: 'og:image', content: 'https://easy-parking.xyz/og-image.png' },
        { property: 'og:site_name', content: '쉽주' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:title', content: title },
        { name: 'twitter:description', content: desc },
        { name: 'twitter:image', content: 'https://easy-parking.xyz/og-image.png' },
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

function VerifiedBadge() {
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] text-stone-400">
      <BadgeCheck className="size-3" />
      검증
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

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[10px] font-semibold tracking-[0.15em] uppercase text-stone-400 mb-4">
      {children}
    </h2>
  )
}

function NearbyPlacesSection({ places }: { places: NearbyPlaceInfo[] }) {
  if (places.length === 0) return null

  return (
    <section>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-[10px] font-semibold tracking-[0.15em] uppercase text-stone-400">
          여기 주차하고 가볼 곳
        </h2>
        <span className="text-[11px] text-stone-400">{places.length}곳</span>
      </div>
      <p className="text-xs text-stone-400 mb-4 mt-0.5">
        자체 주차가 어려워 이 주차장을 이용하면 좋은 주변 장소
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {places.map((place) => {
          const meta = CATEGORY_META[place.category] ?? CATEGORY_META.etc
          return (
            <div
              key={place.id}
              className="flex items-start gap-3 bg-white rounded-2xl p-3.5 shadow-[0_1px_4px_rgba(0,0,0,0.06)]"
            >
              {place.thumbnailUrl ? (
                <img
                  src={place.thumbnailUrl}
                  alt={place.name}
                  className="size-14 rounded-xl object-cover shrink-0"
                  loading="lazy"
                />
              ) : (
                <span className="size-14 rounded-xl bg-stone-100 flex items-center justify-center text-xl shrink-0">
                  {meta.icon}
                </span>
              )}
              <div className="min-w-0">
                <div className="flex items-baseline gap-1.5">
                  <span className="font-semibold text-sm text-stone-900 truncate">
                    {place.name}
                  </span>
                  <span className="text-[11px] text-stone-400 shrink-0">{meta.label}</span>
                </div>
                {place.tip && (
                  <p className="text-xs text-stone-500 mt-0.5 leading-relaxed">{place.tip}</p>
                )}
                <p className="text-[10px] text-stone-400 mt-1">
                  {place.mentionCount}개 블로그 언급
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

  const icon = getDifficultyIcon(lot.difficulty.score)
  const label = getDifficultyLabel(lot.difficulty.score)
  const reliabilityBadge = getReliabilityBadge(lot.difficulty.reliability)
  const isWarnLevel = lot.difficulty.score !== null && lot.difficulty.score < 2.0

  return (
    <div className="min-h-screen bg-[#f9f8f5]">
      {/* 브레드크럼 */}
      <div className="bg-white/80 backdrop-blur-sm border-b border-stone-200">
        <div className="max-w-3xl mx-auto px-4 py-2 text-[11px] text-stone-400 flex items-center gap-1.5">
          <Link to="/" className="hover:text-stone-700 transition-colors">
            지도
          </Link>
          <ChevronRight className="size-2.5" />
          <Link to="/wiki" className="hover:text-stone-700 transition-colors">
            둘러보기
          </Link>
          <ChevronRight className="size-2.5" />
          <span className="text-stone-600 truncate">{lot.name}</span>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4">
        {/* 헤더 */}
        <header className="py-8 border-b border-stone-200">
          <div className="flex items-start justify-between gap-6">
            {/* 타이틀 + 주소 */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                <div
                  className={`size-2.5 rounded-full shrink-0 ${getDifficultyColor(lot.difficulty.score)}`}
                />
                {lot.type && (
                  <span className="text-[11px] text-stone-400 font-medium">{lot.type}</span>
                )}
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold text-stone-900 leading-tight mb-2">
                {lot.name}
              </h1>
              <p className="text-sm text-stone-500 leading-relaxed">{lot.address}</p>
              {lot.poiTags && lot.poiTags.length > 0 && (
                <div className="flex gap-1.5 mt-3 flex-wrap">
                  {lot.poiTags.map((tag) => (
                    <span
                      key={tag}
                      className="text-[11px] text-stone-500 bg-stone-100 px-2.5 py-0.5 rounded-full"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>

            {/* 난이도 평점 블록 */}
            <div className="shrink-0 bg-stone-50 rounded-2xl px-4 py-3.5 text-center min-w-[72px]">
              <div className="text-4xl leading-none mb-1.5">{icon}</div>
              <div className="text-[11px] font-semibold text-stone-600 mb-0.5">{label}</div>
              {lot.difficulty.score !== null ? (
                <div className="text-xl font-bold text-stone-900 tabular-nums leading-none">
                  {lot.difficulty.score.toFixed(1)}
                </div>
              ) : (
                <div className="text-xs text-stone-400">—</div>
              )}
              {lot.difficulty.reviewCount > 0 && (
                <div className="text-[10px] text-stone-400 mt-1">
                  {lot.difficulty.reviewCount}개 리뷰
                </div>
              )}
              {reliabilityBadge && (
                <div className="text-[10px] text-stone-400 mt-0.5">{reliabilityBadge.label}</div>
              )}
            </div>
          </div>

          {/* 액션 바 */}
          <div className="flex items-center gap-2 mt-6">
            <a
              href={`https://map.naver.com/v5/directions/-/${lot.lng},${lot.lat},${encodeURIComponent(lot.name)}/-/transit?c=${lot.lng},${lot.lat},15,0,0,0,dh`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full bg-stone-900 px-4 py-1.5 text-xs font-medium text-white hover:bg-stone-700 transition-colors"
            >
              <ExternalLink className="size-3" />
              길찾기
            </a>
            <Link
              to="/"
              search={{ lotId: lot.id }}
              className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 px-4 py-1.5 text-xs font-medium text-stone-700 hover:bg-stone-50 transition-colors"
            >
              <MapIcon className="size-3" />
              지도에서 보기
            </Link>
            <VoteBookmarkBar lotId={lot.id} />
          </div>
        </header>

        <div className="py-8 space-y-10">
          {/* 큐레이션 사유 */}
          {lot.curationReason && (
            <div
              className={`border-l-[3px] pl-4 ${isWarnLevel ? 'border-red-400' : 'border-emerald-500'}`}
            >
              <p
                className={`text-sm leading-relaxed ${isWarnLevel ? 'text-red-700' : 'text-stone-700'}`}
              >
                {isWarnLevel ? '⚠️' : '✅'} {lot.curationReason}
              </p>
              {lot.featuredSource === '1010' && (
                <p className="text-xs text-stone-400 mt-1.5">📺 10시10분 유튜브에 소개된 주차장</p>
              )}
            </div>
          )}

          {/* 기본 정보 */}
          <section>
            <SectionLabel>기본 정보</SectionLabel>
            <div className="bg-white rounded-2xl shadow-[0_1px_4px_rgba(0,0,0,0.06)] overflow-hidden">
              <dl className="divide-y divide-stone-100">
                {/* 위치 */}
                <div className="flex gap-4 px-5 py-3.5">
                  <dt className="text-xs font-medium text-stone-400 w-14 shrink-0 pt-0.5">위치</dt>
                  <dd className="text-sm text-stone-800 leading-relaxed">{lot.address}</dd>
                </div>

                {/* 운영시간 */}
                <div className="flex gap-4 px-5 py-3.5">
                  <dt className="text-xs font-medium text-stone-400 w-14 shrink-0 pt-0.5">운영</dt>
                  <dd className="text-sm text-stone-800 space-y-0.5">
                    <div className="flex items-center gap-1.5">
                      <span>
                        평일 {lot.operatingHours.weekday.start}–{lot.operatingHours.weekday.end}
                      </span>
                      {lot.verifiedSource && <VerifiedBadge />}
                    </div>
                    <div className="text-xs text-stone-500">
                      토 {lot.operatingHours.saturday.start}–{lot.operatingHours.saturday.end} ·
                      공휴일 {lot.operatingHours.holiday.start}–{lot.operatingHours.holiday.end}
                    </div>
                  </dd>
                </div>

                {/* 요금 */}
                <div className="flex gap-4 px-5 py-3.5">
                  <dt className="text-xs font-medium text-stone-400 w-14 shrink-0 pt-0.5">요금</dt>
                  <dd className="text-sm text-stone-800 space-y-0.5">
                    {lot.pricing.isFree ? (
                      <div className="flex items-center gap-1.5">
                        <span className="text-emerald-700 font-medium">무료</span>
                        {lot.verifiedSource && <VerifiedBadge />}
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-1.5">
                          기본 {lot.pricing.baseTime}분 {lot.pricing.baseFee.toLocaleString()}원
                          {lot.verifiedSource && <VerifiedBadge />}
                        </div>
                        <div className="text-xs text-stone-500">
                          추가 {lot.pricing.extraTime}분당 {lot.pricing.extraFee.toLocaleString()}원
                          {lot.pricing.dailyMax &&
                            ` · 1일 최대 ${lot.pricing.dailyMax.toLocaleString()}원`}
                          {lot.pricing.monthlyPass &&
                            ` · 월정기 ${lot.pricing.monthlyPass.toLocaleString()}원`}
                        </div>
                      </>
                    )}
                  </dd>
                </div>

                {/* 규모 */}
                {lot.totalSpaces > 0 && (
                  <div className="flex gap-4 px-5 py-3.5">
                    <dt className="text-xs font-medium text-stone-400 w-14 shrink-0 pt-0.5">
                      규모
                    </dt>
                    <dd className="text-sm text-stone-800">총 {lot.totalSpaces}면</dd>
                  </div>
                )}

                {/* 전화 */}
                {lot.phone && (
                  <div className="flex gap-4 px-5 py-3.5">
                    <dt className="text-xs font-medium text-stone-400 w-14 shrink-0 pt-0.5">
                      전화
                    </dt>
                    <dd className="text-sm">
                      <a
                        href={`tel:${lot.phone}`}
                        className="text-stone-800 underline underline-offset-2 hover:text-stone-500 transition-colors"
                      >
                        {lot.phone}
                      </a>
                    </dd>
                  </div>
                )}

                {/* 특기사항 */}
                {lot.notes && (
                  <div className="flex gap-4 px-5 py-3.5">
                    <dt className="text-xs font-medium text-stone-400 w-14 shrink-0 pt-0.5">
                      비고
                    </dt>
                    <dd className="text-xs text-stone-500 leading-relaxed">{lot.notes}</dd>
                  </div>
                )}
              </dl>
            </div>
          </section>

          {/* 위치 지도 */}
          <section>
            <SectionLabel>위치</SectionLabel>
            <div className="rounded-2xl overflow-hidden shadow-[0_1px_4px_rgba(0,0,0,0.06)]">
              <WikiMiniMap lat={lot.lat} lng={lot.lng} name={lot.name} />
            </div>
          </section>

          {/* 주변 갈만한 곳 */}
          {nearbyPlaces.length > 0 && <NearbyPlacesSection places={nearbyPlaces} />}

          {/* 리뷰 / 영상 / 웹사이트 */}
          <section>
            <SectionLabel>커뮤니티</SectionLabel>
            <div className="bg-white rounded-2xl shadow-[0_1px_4px_rgba(0,0,0,0.06)] p-5">
              <ParkingTabs lotId={lot.id} expanded />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
