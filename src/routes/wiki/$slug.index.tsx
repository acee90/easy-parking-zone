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
  buildBreadcrumbJsonLd,
  buildParkingFaqJsonLd,
  buildParkingLotJsonLd,
  getParkingCanonicalUrl,
} from '@/lib/parking-jsonld'
import { getRegionForAddress } from '@/lib/parking-regions'
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
  const region = getRegionForAddress(lot.address)
  const breadcrumbJsonLd = buildBreadcrumbJsonLd(lot, region)

  return (
    <div className="min-h-screen bg-zinc-100">
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
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON.stringify output is safe
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd) }}
      />
      <section className="border-b bg-white">
        <div className="mx-auto max-w-6xl px-4 py-4 md:py-6">
          <nav
            aria-label="breadcrumb"
            className="mb-4 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
          >
            <Link to="/wiki" className="transition-colors hover:text-foreground hover:underline">
              둘러보기
            </Link>
            {region && (
              <>
                <ChevronRight className="size-3 shrink-0" />
                <Link
                  to="/wiki/region/$region"
                  params={{ region: region.label }}
                  className="transition-colors hover:text-foreground hover:underline"
                >
                  {region.label} 주차장
                </Link>
              </>
            )}
            <ChevronRight className="size-3 shrink-0" />
            <span className="font-medium text-foreground">{lot.name}</span>
          </nav>

          {/* 정보 4 : 지도 6 — 지도/로드뷰가 더 크게 보이도록 오른쪽에 무게를 준다 */}
          <div className="grid grid-cols-1 gap-5 md:grid-cols-[minmax(0,0.8fr)_minmax(360px,1.2fr)]">
            <div className="flex flex-col gap-5">
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
                <h1 className="text-3xl font-bold leading-tight tracking-tight md:text-4xl">
                  {lot.name}
                </h1>
                <div className="flex items-start gap-2 text-sm text-muted-foreground">
                  <MapPin className="mt-0.5 size-4 shrink-0" />
                  <span>{lot.address}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-zinc-50 p-4">
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

                <div className="rounded-xl bg-zinc-50 p-4 flex items-center">
                  <div className="flex w-full justify-around text-center">
                    <div>
                      <div className="text-xs font-medium text-muted-foreground">리뷰</div>
                      <div className="mt-2 text-3xl font-black leading-none tabular-nums">
                        {tabCounts.reviews}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-medium text-muted-foreground">영상</div>
                      <div className="mt-2 text-3xl font-black leading-none tabular-nums">
                        {tabCounts.media}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs font-medium text-muted-foreground">블로그</div>
                      <div className="mt-2 text-3xl font-black leading-none tabular-nums">
                        {tabCounts.blog}
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 기본 정보 — 방문 전 확인 항목이라 상단에 둔다.
                  주소는 제목 아래에 이미 있으므로 중복 표기하지 않는다. */}
              <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 md:grid-cols-1">
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

              {/* 액션은 한 줄로 — 길찾기가 주(主), 전화는 있을 때만 옆에 붙는다 */}
              <div className="mt-auto flex items-center gap-2">
                <ParkingActionGroup
                  lat={lot.lat}
                  lng={lot.lng}
                  name={lot.name}
                  navigationButtonClassName="h-10"
                />
                {phoneLabel && (
                  <a
                    href={`tel:${phoneLabel}`}
                    aria-label={`전화 ${phoneLabel}`}
                    className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-full bg-zinc-100 px-4 text-sm font-semibold text-zinc-700 transition-colors hover:bg-zinc-200 active:bg-zinc-300"
                  >
                    <Phone className="size-4 shrink-0" />
                    <span className="hidden sm:inline">{phoneLabel}</span>
                  </a>
                )}
              </div>
            </div>

            <WikiMiniMap lat={lot.lat} lng={lot.lng} name={lot.name} />
          </div>
        </div>
      </section>

      {/* 컨텐츠 */}
      <div className="mx-auto max-w-6xl px-4 py-6">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-2 space-y-5">
            {/* 문서형 콘텐츠: 흰 시트 1장. 요약·팁이 모두 없으면 빈 시트가 되므로 렌더하지 않는다. */}
            {hasContentAbove && (
              <div className="rounded-2xl bg-white p-5 md:p-6">
                {summary && (
                  <section>
                    <div className="mb-2 text-xs font-semibold text-primary">AI 요약</div>
                    <p className="whitespace-pre-line text-base font-medium leading-relaxed text-zinc-900">
                      {summary}
                    </p>
                  </section>
                )}

                {/* AI 팁 */}
                {(lot.aiTipPricing || lot.aiTipVisit || lot.aiTipAlternative) && (
                  <section
                    className={`space-y-4 ${summary ? 'mt-6 border-t border-zinc-100 pt-6' : ''}`}
                  >
                    {lot.aiTipPricing && (
                      <div className="text-sm leading-relaxed text-zinc-700">
                        <span className="mb-1 block text-base font-semibold text-zinc-900">
                          {lot.pricing.isFree ? '요금 (무료)' : '요금 (유료)'}
                        </span>
                        {lot.aiTipPricing}
                      </div>
                    )}
                    {lot.aiTipVisit && (
                      <div className="text-sm leading-relaxed text-zinc-700">
                        <span className="mb-1 block text-base font-semibold text-zinc-900">
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
                      <div className="text-sm leading-relaxed text-zinc-700">
                        <span className="mb-1 block text-base font-semibold text-zinc-900">
                          주변 주차장 대안
                        </span>
                        {lot.aiTipAlternative}
                      </div>
                    )}
                  </section>
                )}
              </div>
            )}

            {/* 리뷰/블로그/영상 섹션 (loader에서 prefetch → SSR로 봇 노출) */}
            <ParkingReputationSections
              lotId={lot.id}
              expanded
              initialBlogPosts={blogPosts}
              initialMedia={media}
              initialReviews={reviews}
              initialTabCounts={tabCounts}
              viewAllSlug={slug}
            />
          </div>

          <div className="space-y-4">
            {/* 내부 링크 */}
            <RelatedParkingLotsSection lot={lot} lots={relatedLots} />

            {/* 주변 갈만한 곳 */}
            {nearbyPlaces.length > 0 && <NearbyPlacesSection places={nearbyPlaces} />}
          </div>
        </div>

        {/* 자주 묻는 질문 — 상대적으로 중요도가 낮아 페이지 최하단에 둔다 */}
        <div className="mt-5">
          <FaqSection lot={lot} relatedLots={relatedLots} />
        </div>
      </div>
    </div>
  )
}
