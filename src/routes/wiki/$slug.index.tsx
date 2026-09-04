import { createFileRoute, getRouteApi, Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { ParkingReputationSections } from '@/components/ParkingReputationSections'
import { AlternativeLotsSection } from '@/components/wiki/AlternativeLotsSection'
import { DestinationsForLotSection } from '@/components/wiki/DestinationsForLotSection'
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
    destinations,
  } = parentRoute.useLoaderData()

  const summary = lot.aiSummary
  const slug = makeParkingSlug(lot.name, lot.id)
  // 읽은 글이 0건이면 태그가 있어도 분위기를 열지 않는다 — EvaluationSection 과 같은 기준
  const hasSentiment = webSentiment !== null && webSentiment.count > 0
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
              // `webSources.sources.length` 는 LIMIT 30 페이지 크기다 — 개수가 아니다.
              // `tabCounts.blog` 가 같은 필터(relevance≥40 · 애그리게이터 제외)의 전체 수.
              webCount={tabCounts.blog ?? 0}
            />
          </div>

          {/* 페이지 순서(2026-09-04): 요금·점수 히어로 → AI 후기 요약 → 실제 후기 → 일반 정보.
              중요한 순서대로다. 위치·요금 계산·주변 비교는 "갈지 말지" 정한 뒤에 보는 값이다. */}

          {/* 후기 종합 — 가장 읽을 값이 있는 블록이라 지표 바로 다음에 둔다.
              팁 3종 중 방문·대안은 예전엔 여기 나란히 쌓아 4개짜리 글 벽이 됐다 — 각자
              연관 섹션(위치·대안 목록)으로 옮겼다. 요금 팁은 후기 종합만큼 바로 필요한
              정보라 여기 같이 둔다.
              웹 후기 분위기(막대·자주 나온 말)는 예전엔 「평가」 섹션에서 이용자 별점과
              나란히 그렸다. 점수는 히어로 「쉬움 점수」 하나로 합쳤고, 여기서는 그 근거만 보인다. */}
          {(summary || lot.aiTipPricing || hasSentiment) && (
            <section className="flex flex-col">
              <div className="mb-[11px] flex flex-wrap items-center justify-between gap-2.5">
                <h2 className="m-0 text-[17px] font-extrabold tracking-[-0.015em] text-ink">
                  후기 종합
                </h2>
                {(tabCounts.blog ?? 0) > 0 && (
                  // 목록(sources)은 30건에서 잘리므로 길이를 세지 않는다 — 히어로 캡션과 같은 값
                  <span className="text-[11.5px] tabular-nums text-muted-foreground">
                    후기 {(tabCounts.blog ?? 0).toLocaleString()}건 정리
                  </span>
                )}
              </div>
              {summary && (
                // 페이지의 핵심 문단이다. 본문과 같은 크기로 두면 그냥 지나친다.
                <p className="whitespace-pre-line text-[16.5px] leading-[1.8] text-ink">
                  {summary}
                </p>
              )}
              {lot.aiTipPricing && (
                <div className={`text-[14px] leading-relaxed text-ink-2 ${summary ? 'mt-3' : ''}`}>
                  <span className="mb-0.5 block text-[13px] font-bold text-ink">
                    {lot.pricing.isFree ? '요금 팁 (무료)' : '요금 팁'}
                  </span>
                  {lot.aiTipPricing}
                </div>
              )}
              <EvaluationSection sentiment={webSentiment} />
            </section>
          )}

          {/* 이용자 후기 + 평가 남기기 — AI 요약 다음이 실제 후기다 */}
          <ParkingReputationSections
            lotId={lot.id}
            expanded
            // 흰 시트 위 흰 카드는 경계가 안 보인다 (디자인 규칙 §8)
            bordered
            // 리뷰가 먼저, 작성 폼은 그 뒤다 — 읽는 사람이 먼저 온다.
            sections={['reviews', 'write']}
            initialReviews={reviews}
            initialTabCounts={tabCounts}
            viewAllSlug={slug}
          />

          {/* ── 여기부터는 일반 정보 — 위치 · 요금 계산 · 주변 비교 · FAQ · 근거 ── */}

          {/* 위치 — 「방문 전 확인 항목」 성격이라 방문 팁을 여기 함께 둔다 */}
          <LotLocationSection lot={lot} visitTip={lot.aiTipVisit} />

          {/* 요금 계산 — 요금 정보가 모자란 주차장에서는 스스로 렌더하지 않는다.
              무료 주차장에서는 계산할 것이 없다 (「0원」만 크게 남는다).
              요금 팁은 위 후기 종합에 이미 있어 여기서 또 넣지 않는다. */}
          {!lot.pricing.isFree && <FeeCalculatorSection lot={lot} />}

          {/* 주변 주차장 비교표 — 사이드바에서 본문으로 옮겼다.
            loader가 이미 8곳의 요금·면수·좌표를 들고 있어 추가 조회가 없다. */}
          <RelatedParkingLotsSection lot={lot} lots={relatedLots} />

          {/* 후기에서 함께 언급된 주차장 — "여기 말고 어디" 계열이라 비교표 바로 뒤에 둔다.
            우리 DB 와 이름이 정확히 맞고 3km 이내인 것만 저장돼 있다.
            대안 팁도 같은 주제라 여기 함께 둔다. */}
          <AlternativeLotsSection items={alternativeLots} tip={lot.aiTipAlternative} />

          {/* 이 주차장으로 갈 수 있는 곳 — 목적지 페이지(/near)로 올라가는 링크 (#166).
            발행된 목적지가 없으면 스스로 그리지 않는다. */}
          <DestinationsForLotSection items={destinations} />

          {/* 자주 묻는 질문 — 우리가 쓴 문답이라 근거 목록보다 앞에 둔다 */}
          <FaqSection lot={lot} relatedLots={relatedLots} />

          {/* 참고한 웹 글 — 제목·도메인·날짜·링크만. 기본 접힘.
            원문은 한 조각도 그리지 않는다(저작권 + 긁어온 글 재게시 회피).
            근거 목록이라 페이지 맨 끝이다. */}
          <WebSourceListSection
            sources={webSources.sources}
            excludedCount={webSources.excludedCount}
            totalCount={tabCounts.blog ?? 0}
          />
          {/* 주변 갈만한 곳 — 사이드바를 없앴다. 시안은 단일 흐름이다 */}
          {nearbyPlaces.length > 0 && <NearbyPlacesSection places={nearbyPlaces} />}
        </div>
      </div>
    </div>
  )
}
