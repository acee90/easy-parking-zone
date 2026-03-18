/** 주차장 이름 → URL slug 변환 */
function toSlug(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[\/\\?#%&=+]/g, "")  // URL 예약 문자 제거
}

/** 이름+ID를 합쳐 slug 생성: "서울역-공영주차장-118-2-000081" */
export function makeParkingSlug(name: string, id: string): string {
  return `${toSlug(name)}-${id}`
}

/**
 * slug에서 ID 추출
 * ID 패턴: "000-1-000001" (공공데이터) | "KA-1000006682" (카카오) | "NV-1268422156_375622893" (네이버)
 */
export function parseIdFromSlug(slug: string): string {
  // KA-숫자 또는 NV-숫자_숫자
  const kvMatch = slug.match(/((?:KA|NV)-[\d_]+)$/)
  if (kvMatch) return kvMatch[1]
  // 공공데이터: 숫자-숫자-숫자
  const pubMatch = slug.match(/(\d{3}-\d+-\d+)$/)
  if (pubMatch) return pubMatch[1]
  // fallback: slug 자체가 ID
  return slug
}
