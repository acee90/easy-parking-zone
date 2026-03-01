/** Haversine distance in km between two points */
export function getDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function toRad(deg: number) {
  return (deg * Math.PI) / 180
}

/** Default center: 서울 시청 */
export const DEFAULT_CENTER = { lat: 37.5666, lng: 126.9784 }
export const DEFAULT_ZOOM = Number(import.meta.env.VITE_DEFAULT_ZOOM) || 14

/** Difficulty score → 아이콘 (쉬움=😊, 어려움=💀) */
export function getDifficultyIcon(score: number | null): string {
  if (score === null) return '🅿️'     // 리뷰 없음
  if (score >= 4.0) return '😊'       // 초보 추천
  if (score >= 2.5) return '🙂'       // 보통
  if (score >= 1.5) return '💀'       // 주의
  return '💀💀'                        // 초보 비추
}

/** Difficulty score to label */
export function getDifficultyLabel(score: number | null): string {
  if (score === null) return '리뷰 없음'
  if (score >= 4.0) return '초보 추천'
  if (score >= 2.5) return '보통'
  if (score >= 1.5) return '주의'
  return '초보 비추'
}
