import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { ParkingReputationSections } from '@/components/ParkingReputationSections'
import { AlternativeLotsSection } from '@/components/wiki/AlternativeLotsSection'
import { EvaluationSection } from '@/components/wiki/EvaluationSection'
import { FaqSection } from '@/components/wiki/FaqSection'
import { FeeCalculatorSection } from '@/components/wiki/FeeCalculatorSection'
import { LotHeroSection } from '@/components/wiki/LotHeroSection'
import { LotLocationSection } from '@/components/wiki/LotLocationSection'
import { NearbyPlacesSection } from '@/components/wiki/NearbyPlacesSection'
import { RelatedParkingLotsSection } from '@/components/wiki/RelatedParkingLotsSection'
import { WebSourceListSection } from '@/components/wiki/WebSourceListSection'
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
  const {
    lot,
    nearbyPlaces,
    reviews,
    tabCounts,
    relatedLots,
    webSentiment,
    webSources,
    alternativeLots,
  } = parentRoute.useLoaderData()

  const summary = lot.aiSummary
  const slug = makeParkingSlug(lot.name, lot.id)
  const hasAiTips = Boolean(lot.aiTipPricing || lot.aiTipVisit || lot.aiTipAlternative)
  // TanStack Start head API의 links/scripts가 SSR HTML에 직렬화 안 되어
  // React 19 metadata hoisting으로 head에 inject한다.
  const canonicalUrl = getParkingCanonicalUrl(lot)
  // 별점 마크업은 실사용자 리뷰가 있을 때만 (시드 제외)
  const lotJsonLd = buildParkingLotJsonLd(
    lot,
    tabCounts.realReviews ?? 0,
    tabCounts.realReviewScore ?? null,
  )
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
      {/* 시안은 밴드로 나뉜 화면이 아니라 위에서 아래로 이어지는 한 장의 문서다.
          섹션 사이 간격(26px)과 헤어라인이 구조를 만들고, 흰 카드는 쓰지 않는다. */}
      {/* 상세페이지는 **흰 시트 1장 + 내부 디바이더**다 (디자인 규칙 §4).
          섹션마다 카드를 씌우거나 회색 면을 깔지 않는다 — 시트 안의 시트가 되고(§5),
          회색 위 본문은 읽기 어렵다(§2, 회색 필은 인풋 전용). */}
      <div className="mx-auto max-w-[900px] px-4 py-5 text-[15px] leading-[1.65] md:px-5 md:py-6">
        <div className="flex flex-col divide-y divide-zinc-100 rounded-[10px] bg-white [&>*]:px-4 [&>*]:py-5 md:[&>*]:px-6">
          <div className="flex flex-col gap-4">
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

            {/* 이름·주소·핵심 지표를 한 줄로 편다.
              지도는 아래 「위치」 섹션으로 내렸다 — 옆에 붙여 두면 이름과 지표가 좁은 칸에 갇힌다. */}
            <LotHeroSection
              lot={lot}
              realReviewCount={tabCounts.realReviews ?? 0}
              realReviewScore={tabCounts.realReviewScore ?? null}
            />
          </div>

          {/* 웹 후기 분위기 — 히어로의 이용자 별점 바로 아래에 붙인다.
            둘 다 "이 주차장이 어떤가"에 답하는 값이라 떨어져 있으면 두 번 판단하게 된다.
            이용자 별점은 히어로가 정본이고 여기서는 웹 글의 어조만 다룬다(중복 제거). */}
          {/* 후기 종합 — 이 페이지에서 가장 읽을 값이 있는 블록이라 지표 바로 다음에 둔다.
              시안은 「평가 남기기」 뒤였는데, 실제로 그리고 보니 스크롤 절반 아래로 밀려
              눈에 띄지 않았다. 팁도 같은 종합에서 나온 값이라 함께 둔다. */}
          {(summary || hasAiTips) && (
            <section className="flex flex-col">
              <div className="mb-[11px] flex flex-wrap items-center justify-between gap-2.5">
                <h2 className="m-0 text-[17px] font-extrabold tracking-[-0.015em] text-ink">
                  후기 종합
                </h2>
                {webSources.sources.length > 0 && (
                  <span className="text-[11.5px] tabular-nums text-muted-foreground">
                    후기 {webSources.sources.length.toLocaleString()}건 정리
                  </span>
                )}
              </div>
              {summary && (
                // 페이지의 핵심 문단이다. 본문과 같은 크기로 두면 그냥 지나친다.
                <p className="whitespace-pre-line text-[16.5px] leading-[1.8] text-ink">
                  {summary}
                </p>
              )}
              {hasAiTips && (
                <div className={`space-y-3 ${summary ? 'mt-4' : ''}`}>
                  {lot.aiTipPricing && (
                    <div className="text-[14px] leading-relaxed text-ink-2">
                      <span className="mb-0.5 block text-[13px] font-bold text-ink">
                        {lot.pricing.isFree ? '요금 (무료)' : '요금 (유료)'}
                      </span>
                      {lot.aiTipPricing}
                    </div>
                  )}
                  {lot.aiTipVisit && (
                    <div className="text-[14px] leading-relaxed text-ink-2">
                      <span className="mb-0.5 block text-[13px] font-bold text-ink">
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
                    <div className="text-[14px] leading-relaxed text-ink-2">
                      <span className="mb-0.5 block text-[13px] font-bold text-ink">
                        주변 주차장 대안
                      </span>
                      {lot.aiTipAlternative}
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {/* 위치 */}
          <LotLocationSection lot={lot} />

          <EvaluationSection
            userScore={tabCounts.realReviewScore ?? null}
            userCount={tabCounts.realReviews ?? 0}
            sentiment={webSentiment}
          />

          {/* 이용자 후기 + 평가 남기기 —— 사람이 쓴 것을 위에 둔다.
              실사용자 리뷰가 87곳(0.27%)뿐이라 작성 폼이 하단에 있으면 참여가 늘 수 없다. */}
          <ParkingReputationSections
            lotId={lot.id}
            expanded
            // 흰 시트 위 흰 카드는 경계가 안 보인다 (디자인 규칙 §8)
            bordered
            sections={['reviews', 'write']}
            initialReviews={reviews}
            initialTabCounts={tabCounts}
            viewAllSlug={slug}
          />
          {/* 요금 계산 — 요금 정보가 모자란 주차장에서는 스스로 렌더하지 않는다.
              무료 주차장에서는 계산할 것이 없다 (「0원」만 크게 남는다). */}
          {!lot.pricing.isFree && <FeeCalculatorSection lot={lot} />}

          {/* 주변 주차장 비교표 — 사이드바에서 본문으로 옮겼다.
            loader가 이미 8곳의 요금·면수·좌표를 들고 있어 추가 조회가 없다. */}
          <RelatedParkingLotsSection lot={lot} lots={relatedLots} />

          {/* 후기에서 함께 언급된 주차장 — "여기 말고 어디" 계열이라 비교표 바로 뒤에 둔다.
            우리 DB 와 이름이 정확히 맞고 3km 이내인 것만 저장돼 있다. */}
          <AlternativeLotsSection items={alternativeLots} />

          {/* 자주 묻는 질문 — 우리가 쓴 문답이라 근거 목록보다 앞에 둔다 */}
          <FaqSection lot={lot} relatedLots={relatedLots} />

          {/* 참고한 웹 글 — 제목·도메인·날짜·링크만. 기본 접힘.
            원문은 한 조각도 그리지 않는다(저작권 + 긁어온 글 재게시 회피).
            근거 목록이라 페이지 맨 끝이다. */}
          <WebSourceListSection
            sources={webSources.sources}
            excludedCount={webSources.excludedCount}
          />
          {/* 주변 갈만한 곳 — 사이드바를 없앴다. 시안은 단일 흐름이다 */}
          {nearbyPlaces.length > 0 && <NearbyPlacesSection places={nearbyPlaces} />}
        </div>
      </div>
    </div>
  )
}
