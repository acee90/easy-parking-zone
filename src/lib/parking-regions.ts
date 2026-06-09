/**
 * 주차장 광역 지역 허브(/wiki/all?region=<prefix>)용 지역 목록 + 주소 매핑.
 * 토픽 클러스터링: 상세 페이지가 자기 지역 허브로 상향 링크할 때 이 매핑을 쓴다.
 *
 * ⚠️ src/server/sitemap-handler.ts의 REGION_PREFIXES와 prefix가 일치해야 한다.
 */
export interface ParkingRegion {
  label: string
  prefix: string
}

export const PARKING_REGIONS: ParkingRegion[] = [
  { label: '서울', prefix: '서울' },
  { label: '경기', prefix: '경기' },
  { label: '부산', prefix: '부산' },
  { label: '인천', prefix: '인천' },
  { label: '대구', prefix: '대구' },
  { label: '대전', prefix: '대전' },
  { label: '광주', prefix: '광주' },
  { label: '울산', prefix: '울산' },
  { label: '제주', prefix: '제주' },
]

/**
 * 주소 앞부분으로 광역 지역(허브)을 찾는다. 매칭 없으면 null.
 * 예: '서울 양천구 …' → 서울, '경기도 성남시 …' → 경기, '강원특별자치도 …' → null(허브 없음).
 */
export function getRegionForAddress(address: string | null | undefined): ParkingRegion | null {
  if (!address) return null
  const trimmed = address.trimStart()
  return PARKING_REGIONS.find((region) => trimmed.startsWith(region.prefix)) ?? null
}
