import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router'
import {
  ChevronRight,
  Clock,
  CreditCard,
  Flame,
  MapPin,
  ParkingSquare,
  Phone,
  Tag,
  ThumbsUp,
} from 'lucide-react'
import { ParkingActionGroup } from '@/components/ParkingActionGroup'
import { ParkingReputationSections } from '@/components/ParkingReputationSections'
import { Badge } from '@/components/ui/badge'
import { WikiMiniMap } from '@/components/WikiMiniMap'
import { FaqSection } from '@/components/wiki/FaqSection'
import { NearbyPlacesSection } from '@/components/wiki/NearbyPlacesSection'
import { RelatedParkingLotsSection } from '@/components/wiki/RelatedParkingLotsSection'
import { getReliabilityBadge } from '@/lib/geo-utils'
import {
  formatOperatingHours,
  formatPhone,
  formatPricing,
  formatTotalSpaces,
} from '@/lib/parking-display'
import {
  buildParkingFaqJsonLd,
  buildParkingLotJsonLd,
  getParkingCanonicalUrl,
} from '@/lib/parking-jsonld'
import { makeParkingSlug } from '@/lib/slug'

const parentRoute = getRouteApi('/wiki/$slug')

export const Route = createFileRoute('/wiki/$slug/')({
  component: WikiDetailPage,
})

function WikiDetailPage() {
  const { lot, nearbyPlaces, blogPosts, media, reviews, tabCounts, relatedLots } =
    parentRoute.useLoaderData()

  const score = lot.difficulty.score
  const reliabilityBadge = getReliabilityBadge(lot.difficulty.reliability)
  const sourceCount = tabCounts.reviews + tabCounts.blog + tabCounts.media
  const summary = lot.aiSummary
  const operatingHours = formatOperatingHours(lot.operatingHours)
  const pricing = formatPricing(lot.pricing)
  const totalSpacesLabel = formatTotalSpaces(lot.totalSpaces)
  const phoneLabel = formatPhone(lot.phone)
  const slug = makeParkingSlug(lot.name, lot.id)
  const hasAiTips = Boolean(lot.aiTipPricing || lot.aiTipVisit || lot.aiTipAlternative)
  const hasContentAbove = Boolean(summary) || hasAiTips
  // TanStack Start head API의 links/scripts가 SSR HTML에 직렬화 안 되어
  // React 19 metadata hoisting으로 head에 inject한다.
  const canonicalUrl = getParkingCanonicalUrl(lot)
  const lotJsonLd = buildParkingLotJsonLd(lot)
  const faqJsonLd = buildParkingFaqJsonLd(lot, relatedLots)

  return (
    <div className="min-h-screen bg-white">
      <link rel="canonical" href={canonicalUrl} />
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON.stringify output is safe
        dangerouslySetInnerHTML={{ __html: JSON.stringify(lotJsonLd) }}
      />
      {faqJsonLd && (
        <script
          type="application/ld+json"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON.stringify output is safe
          dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }}
        />
      )}
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
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-medium text-muted-foreground">쉬움 점수</span>
                    {reliabilityBadge && (
                      <Badge
                        variant="outline"
                        className={`text-[10px] ${reliabilityBadge.className}`}
                      >
                        {reliabilityBadge.label}
                      </Badge>
                    )}
                  </div>
                  <div className="mt-2 flex items-end gap-2">
                    <span className="text-4xl font-black leading-none">
                      {score === null ? '-' : score.toFixed(1)}
                    </span>
                    <span className="pb-1 text-sm font-semibold text-muted-foreground">/ 5</span>
                  </div>
                </div>

                <div className="rounded-lg border bg-white p-4">
                  <div className="text-xs font-medium text-muted-foreground">리뷰/영상/블로그</div>
                  <div className="mt-2 text-4xl font-black leading-none">{sourceCount}</div>
                </div>
              </div>

              <ParkingActionGroup lotId={lot.id} lat={lot.lat} lng={lot.lng} name={lot.name} />
            </div>
          </div>
        </div>
        <Link
          to="/wiki"
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
                    <span className="mb-1 block text-base font-semibold text-gray-900">
                      {lot.pricing.isFree ? '요금 (무료)' : '요금 (유료)'}
                    </span>
                    {lot.aiTipPricing}
                  </div>
                )}
                {lot.aiTipVisit && (
                  <div className="rounded-lg border bg-white px-4 py-3 text-sm leading-relaxed text-gray-700">
                    <span className="mb-1 block text-base font-semibold text-gray-900">
                      {lot.difficulty.score !== null && lot.difficulty.score >= 4.0
                        ? '방문 팁 (초보 추천)'
                        : lot.difficulty.score !== null && lot.difficulty.score < 2.0
                          ? '방문 팁 (주의 필요)'
                          : '방문 팁'}
                    </span>
                    {lot.aiTipVisit}
                  </div>
                )}
                {lot.aiTipAlternative && (
                  <div className="rounded-lg border bg-white px-4 py-3 text-sm leading-relaxed text-gray-700">
                    <span className="mb-1 block text-base font-semibold text-gray-900">
                      주변 주차장 대안
                    </span>
                    {lot.aiTipAlternative}
                  </div>
                )}
              </section>
            )}

            {/* 기본 정보 */}
            <section
              className={hasContentAbove ? 'border-t-2 border-zinc-300 pt-7 pb-8' : 'pt-2 pb-8'}
            >
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
                  <div>
                    <a
                      href={`tel:${phoneLabel}`}
                      className="inline-flex h-8 items-center justify-center gap-2 rounded-full bg-gray-100 px-3 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-200"
                    >
                      <Phone className="size-3.5 shrink-0" />
                      <span>{phoneLabel}</span>
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

            <FaqSection lot={lot} relatedLots={relatedLots} />

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
            {/* 내부 링크 */}
            <RelatedParkingLotsSection lot={lot} lots={relatedLots} />

            {/* 주변 갈만한 곳 */}
            {nearbyPlaces.length > 0 && <NearbyPlacesSection places={nearbyPlaces} />}
          </div>
        </div>
      </div>
    </div>
  )
}
