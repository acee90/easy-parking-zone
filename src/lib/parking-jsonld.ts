import { generateFaqItems } from '@/lib/faq-generator'
import { isUnsetTimeRange } from '@/lib/parking-display'
import type { ParkingRegion } from '@/lib/parking-regions'
import { makeParkingSlug } from '@/lib/slug'
import type { ParkingLot } from '@/types/parking'

const SITE_URL = 'https://easy-parking.xyz'

/**
 * @param realReviewCount  시드를 제외한 실사용자 리뷰 수
 * @param realReviewScore  같은 모집단(is_seed=0)의 평균 별점. 없으면 AggregateRating 을 안 낸다.
 */
/** `9:00` 처럼 한 자리로 들어온 시각을 `09:00` 으로 맞춘다 (schema.org 는 HH:MM 을 요구한다) */
function toIsoTime(value: string): string | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/)
  if (!m) return null
  const h = Number(m[1])
  if (!Number.isFinite(h) || h < 0 || h > 24) return null
  // 24:00 은 schema.org 에서 유효하지 않다. 자정 마감은 23:59 로 낮춘다.
  if (h === 24) return '23:59'
  return `${String(h).padStart(2, '0')}:${m[2]}`
}

/**
 * 운영시간 → schema.org openingHoursSpecification
 *
 * 값이 있는데 구조화 데이터로 내보내지 않고 있던 항목이다 (운영시간 보유 25,216 lot).
 * 미상(`isUnsetTimeRange`)인 요일은 넣지 않는다 — 화면에 "정보 없음"으로 나오는 시간을
 * 검색엔진에만 확정값처럼 내보내면 안 된다.
 */
function buildOpeningHours(hours: ParkingLot['operatingHours']) {
  const specs: Array<{
    '@type': 'OpeningHoursSpecification'
    dayOfWeek: string[]
    opens: string
    closes: string
  }> = []

  const add = (dayOfWeek: string[], range: { start: string; end: string }) => {
    if (isUnsetTimeRange(range)) return
    const opens = toIsoTime(range.start)
    const closes = toIsoTime(range.end)
    if (!opens || !closes) return
    specs.push({ '@type': 'OpeningHoursSpecification', dayOfWeek, opens, closes })
  }

  add(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'], hours.weekday)
  add(['Saturday'], hours.saturday)
  // 공휴일 칸은 이 데이터에서 일요일·공휴일을 함께 가리킨다
  add(['Sunday', 'PublicHolidays'], hours.holiday)

  return specs
}

export function buildParkingLotJsonLd(
  lot: ParkingLot,
  realReviewCount = 0,
  realReviewScore: number | null = null,
) {
  const slug = makeParkingSlug(lot.name, lot.id)
  const openingHours = buildOpeningHours(lot.operatingHours)
  return {
    '@context': 'https://schema.org',
    '@type': ['LocalBusiness', 'ParkingFacility'],
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
    url: `${SITE_URL}/wiki/${encodeURI(slug)}`,
    ...(lot.totalSpaces > 0 && { maximumAttendeeCapacity: lot.totalSpaces }),
    ...(lot.phone && { telephone: lot.phone }),
    ...(openingHours.length > 0 && { openingHoursSpecification: openingHours }),
    ...(lot.pricing.isFree
      ? { isAccessibleForFree: true }
      : {
          isAccessibleForFree: false,
          // 요금표가 없는 곳(실측 676곳은 컬럼에 문자열 'null' 이 들어 있었다)에
          // "기본 0분 0원" 을 내보내던 자리다. 값이 없으면 필드를 빼는 게 맞다.
          ...(lot.pricing.baseTime > 0 && lot.pricing.baseFee > 0
            ? {
                priceRange: `기본 ${lot.pricing.baseTime}분 ${lot.pricing.baseFee.toLocaleString()}원`,
              }
            : {}),
        }),
    // 별점 마크업은 실사용자 리뷰가 있을 때만 내보낸다.
    //
    // 과거에는 `lot.difficulty.score !== null` 을 조건으로 썼는데, 그 점수는 구조적 추정치라
    // parking_lot_stats 31,939행(99.8%)에 채워져 있다. 결과적으로 리뷰가 한 건도 없는
    // 페이지까지 별점을 달고 나갔고, `ratingCount: ... || 1` 은 리뷰 0건일 때 1을 지어냈다.
    // 실사용자 리뷰 보유 lot 은 87곳(0.27%)뿐이다 (2026-09-02 remote 실측).
    //
    // ⚠️ ratingValue 와 ratingCount 는 **같은 모집단**이어야 한다.
    //    한때 ratingValue 에 `lot.difficulty.score`(구조적 추정치)를 쓰면서 ratingCount 에는
    //    실사용자 리뷰 수를 넣었다. "2명이 4.2점을 줬다"고 말하지만 4.2 는 그 2명이 준
    //    점수가 아니었다. 지금은 둘 다 is_seed=0 리뷰에서만 나온다.
    ...(realReviewCount > 0 &&
      realReviewScore !== null && {
        aggregateRating: {
          '@type': 'AggregateRating',
          ratingValue: realReviewScore.toFixed(1),
          bestRating: '5',
          // 별점 입력은 0.5 단위이고 실제로 0.5를 준 리뷰가 있다.
          // worstRating 을 1 로 두면 ratingValue 가 하한보다 낮아 구조화 데이터가 무효가 된다.
          worstRating: '0.5',
          ratingCount: realReviewCount,
        },
      }),
  }
}

export function buildParkingFaqJsonLd(lot: ParkingLot, relatedLots: ParkingLot[]) {
  const faqItems = generateFaqItems(lot, relatedLots)
  if (faqItems.length < 3) return null
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: { '@type': 'Answer', text: item.answer },
    })),
  }
}

export function getParkingCanonicalUrl(lot: ParkingLot): string {
  return `${SITE_URL}/wiki/${encodeURI(makeParkingSlug(lot.name, lot.id))}`
}

/**
 * 상세 페이지 breadcrumb 구조화데이터: 둘러보기 › {지역} 주차장 › {상세}.
 * region이 null이면 지역 단계를 생략한다.
 * 지역 단계는 지역 허브(/wiki/region/<label>)를 가리킨다 — region.$region.tsx의 canonical과 일치.
 */
export function buildBreadcrumbJsonLd(lot: ParkingLot, region: ParkingRegion | null) {
  const items: Array<{ name: string; url: string }> = [
    { name: '주차장 둘러보기', url: `${SITE_URL}/wiki` },
  ]
  if (region) {
    items.push({
      name: `${region.label} 주차장`,
      url: `${SITE_URL}/wiki/region/${encodeURIComponent(region.label)}`,
    })
  }
  items.push({ name: lot.name, url: getParkingCanonicalUrl(lot) })

  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  }
}
