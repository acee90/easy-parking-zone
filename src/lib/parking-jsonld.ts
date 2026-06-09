import { generateFaqItems } from '@/lib/faq-generator'
import type { ParkingRegion } from '@/lib/parking-regions'
import { makeParkingSlug } from '@/lib/slug'
import type { ParkingLot } from '@/types/parking'

const SITE_URL = 'https://easy-parking.xyz'

export function buildParkingLotJsonLd(lot: ParkingLot) {
  const slug = makeParkingSlug(lot.name, lot.id)
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
 * 지역 URL 인코딩은 all.tsx의 self-canonical(URLSearchParams)과 일치시킨다.
 */
export function buildBreadcrumbJsonLd(lot: ParkingLot, region: ParkingRegion | null) {
  const items: Array<{ name: string; url: string }> = [
    { name: '주차장 둘러보기', url: `${SITE_URL}/wiki` },
  ]
  if (region) {
    items.push({
      name: `${region.label} 주차장`,
      url: `${SITE_URL}/wiki/all?region=${encodeURIComponent(region.prefix)}`,
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
