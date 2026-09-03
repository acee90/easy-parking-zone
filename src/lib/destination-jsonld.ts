/**
 * 목적지 페이지(/near/{목적지}) 구조화 데이터 (#166)
 *
 * Place(목적지) + ItemList(주차장 N곳) + BreadcrumbList.
 * AggregateRating 은 내보내지 않는다 — 목적지에 대한 평점을 우리는 갖고 있지 않다.
 */
import type { Destination, DestinationLot } from '@/types/parking'
import { getParkingCanonicalUrl } from './parking-jsonld'

const SITE_URL = 'https://easy-parking.xyz'

export function getDestinationCanonicalUrl(dest: Pick<Destination, 'slug'>): string {
  return `${SITE_URL}/near/${encodeURI(dest.slug)}`
}

/**
 * <title>. 검색어 "○○ 근처 주차장" 과 같은 형태로 시작하고, 값이 있는 숫자만 붙인다.
 * "석촌역 근처 주차장 11곳 · 무료 7곳 · 초보 추천 2곳 | 쉬운주차장"
 */
export function buildDestinationTitle(dest: Destination, easyCount: number): string {
  const parts = [`${dest.name} 근처 주차장 ${dest.lotCount}곳`]
  if (dest.freeCount > 0) parts.push(`무료 ${dest.freeCount}곳`)
  if (easyCount > 0) parts.push(`초보 추천 ${easyCount}곳`)
  return `${parts.join(' · ')} | 쉬운주차장`
}

export function buildDestinationDescription(dest: Destination, lots: DestinationLot[]): string {
  const nearest = lots[0]
  const head = `${dest.name} 반경 1km 주차장 ${dest.lotCount}곳의 요금·면수·난이도 비교.`
  const near = nearest ? ` 가장 가까운 곳은 ${nearest.lot.name}(직선 ${nearest.distanceM}m).` : ''
  const free = dest.freeCount > 0 ? ` 무료 ${dest.freeCount}곳.` : ''
  return `${head}${near}${free}`
}

export function buildDestinationJsonLd(dest: Destination, lots: DestinationLot[]) {
  const url = getDestinationCanonicalUrl(dest)
  const place = {
    '@context': 'https://schema.org',
    '@type': dest.category === 'station' ? 'TrainStation' : 'Place',
    '@id': `${url}#place`,
    name: dest.name,
    url,
    geo: { '@type': 'GeoCoordinates', latitude: dest.lat, longitude: dest.lng },
    ...(dest.address ? { address: dest.address } : {}),
  }
  const list = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${dest.name} 근처 주차장`,
    numberOfItems: lots.length,
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
    itemListElement: lots.map((dl) => ({
      '@type': 'ListItem',
      position: dl.rank,
      item: {
        '@type': 'ParkingFacility',
        name: dl.lot.name,
        url: getParkingCanonicalUrl(dl.lot),
        geo: { '@type': 'GeoCoordinates', latitude: dl.lot.lat, longitude: dl.lot.lng },
      },
    })),
  }
  return { place, list }
}

export function buildDestinationBreadcrumbJsonLd(dest: Destination) {
  const items = [
    { name: '주차장 둘러보기', url: `${SITE_URL}/wiki` },
    { name: `${dest.name} 근처 주차장`, url: getDestinationCanonicalUrl(dest) },
  ]
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: item.url,
    })),
  }
}
