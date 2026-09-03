/** 주차장 이름 → URL slug 변환 */
function toSlug(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[/\\?#%&=+]/g, '') // URL 예약 문자 제거
}

/** 이름+ID를 합쳐 slug 생성: "서울역-공영주차장-118-2-000081" */
export function makeParkingSlug(name: string, id: string): string {
  return `${toSlug(name)}-${id}`
}

/**
 * 목적지 slug: "석촌역-D-0001". 주차장과 같은 규칙(이름-id)이라
 * 이름이 바뀌어도 id 로 해석되고, 같은 이름의 역이 둘이어도 충돌하지 않는다 (#166)
 */
export function makeDestinationSlug(name: string, id: string): string {
  return `${toSlug(name)}-${id}`
}

/**
 * slug에서 ID 추출
 * ID 패턴: "000-1-000001" (공공데이터) | "KA-1000006682" (카카오) | "NV-1268422156_375622893" (네이버)
 */
export function parseIdFromSlug(slug: string): string | null {
  // KA-숫자 또는 NV-숫자_숫자
  const kvMatch = slug.match(/((?:KA|NV)-[\d_]+)$/)
  if (kvMatch) return kvMatch[1]
  // 공공데이터: 숫자-숫자-숫자
  const pubMatch = slug.match(/(\d{3}-\d+-\d+)$/)
  if (pubMatch) return pubMatch[1]
  return null
}

/** 목적지 slug 에서 "D-0001" 추출. 주차장 id 패턴과 섞이지 않도록 별도 함수로 둔다 */
export function parseDestinationIdFromSlug(slug: string): string | null {
  const m = slug.match(/(D-\d+)$/)
  return m ? m[1] : null
}
