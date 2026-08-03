/**
 * 주차장 광역 지역 허브(/wiki/region/<label>)용 지역 목록 + 주소 매핑.
 * 토픽 클러스터링: 상세 페이지가 자기 지역 허브로 상향 링크할 때 이 매핑을 쓴다.
 *
 * label은 허브 라우트 param(/wiki/region/$region)이자 UI 표기.
 * prefixes는 주소 표기 혼재 대응('경북'/'경상북도', '전북특별자치도'/'전라북도' 등) —
 * 어느 하나로 시작하면 해당 지역으로 본다. '강원특별자치도'처럼 긴 표기도
 * 짧은 prefix('강원')로 함께 커버된다.
 */
export interface ParkingRegion {
  label: string
  prefixes: string[]
}

export const PARKING_REGIONS: ParkingRegion[] = [
  { label: '서울', prefixes: ['서울'] },
  { label: '경기', prefixes: ['경기'] },
  { label: '인천', prefixes: ['인천'] },
  { label: '부산', prefixes: ['부산'] },
  { label: '대구', prefixes: ['대구'] },
  { label: '대전', prefixes: ['대전'] },
  { label: '광주', prefixes: ['광주'] },
  { label: '울산', prefixes: ['울산'] },
  { label: '세종', prefixes: ['세종'] },
  { label: '강원', prefixes: ['강원'] },
  { label: '충북', prefixes: ['충북', '충청북도'] },
  { label: '충남', prefixes: ['충남', '충청남도'] },
  { label: '전북', prefixes: ['전북', '전라북도'] },
  { label: '전남', prefixes: ['전남', '전라남도'] },
  { label: '경북', prefixes: ['경북', '경상북도'] },
  { label: '경남', prefixes: ['경남', '경상남도'] },
  { label: '제주', prefixes: ['제주'] },
]

/** 허브 라우트 param(label)으로 지역을 찾는다. 없으면 null. */
export function getRegionByLabel(label: string | null | undefined): ParkingRegion | null {
  if (!label) return null
  return PARKING_REGIONS.find((region) => region.label === label) ?? null
}

/**
 * 주소 앞부분으로 광역 지역(허브)을 찾는다. 매칭 없으면 null.
 * 예: '서울 양천구 …' → 서울, '경상북도 경주시 …' → 경북, '강원특별자치도 …' → 강원.
 */
export function getRegionForAddress(address: string | null | undefined): ParkingRegion | null {
  if (!address) return null
  const trimmed = address.trimStart()
  return (
    PARKING_REGIONS.find((region) =>
      region.prefixes.some((prefix) => trimmed.startsWith(prefix)),
    ) ?? null
  )
}
