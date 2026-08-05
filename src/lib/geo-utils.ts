/** Haversine distance in km between two points */
export function getDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
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

/**
 * 정방위각(from → to). 0 = 정북, 시계방향으로 증가(동 = 90).
 * 네이버 Panorama의 `pov.pan`과 같은 규약이라 그대로 넘길 수 있다.
 */
export function getBearing(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const φ1 = toRad(lat1)
  const φ2 = toRad(lat2)
  const Δλ = toRad(lng2 - lng1)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

/** Default center: 서울 시청 */
export const DEFAULT_CENTER = { lat: 37.5666, lng: 126.9784 }
export const DEFAULT_ZOOM = Number(import.meta.env.VITE_DEFAULT_ZOOM) || 17

/** Difficulty score → 아이콘 (6단계) */
export function getDifficultyIcon(score: number | null): string {
  if (score === null) return '🅿️' // 데이터 없음
  if (score >= 4.0) return '😊' // 초보추천
  if (score >= 3.3) return '🙂' // 무난
  if (score >= 2.7) return '😐' // 보통
  if (score >= 2.0) return '😕' // 별로
  if (score >= 1.5) return '💀' // 비추
  return '🔥' // 헬
}

/** Difficulty score → Tailwind bg color class (6단계) */
export function getDifficultyColor(score: number | null): string {
  if (score === null) return 'bg-gray-400'
  if (score >= 4.0) return 'bg-green-500'
  if (score >= 3.3) return 'bg-green-300'
  if (score >= 2.7) return 'bg-zinc-300'
  if (score >= 2.0) return 'bg-amber-400'
  if (score >= 1.5) return 'bg-orange-500'
  return 'bg-red-500'
}

/** Difficulty score to label (6단계) */
export function getDifficultyLabel(score: number | null): string {
  if (score === null) return '데이터 없음'
  if (score >= 4.0) return '초보추천'
  if (score >= 3.3) return '무난'
  if (score >= 2.7) return '보통'
  if (score >= 2.0) return '별로'
  if (score >= 1.5) return '비추'
  return '헬'
}

type Reliability = 'confirmed' | 'estimated' | 'reference' | 'structural' | 'none'

/** 신뢰도 등급 → 뱃지 표시 정보 (null = 뱃지 불필요) */
export function getReliabilityBadge(reliability: Reliability | undefined): {
  label: string
  className: string
} | null {
  switch (reliability) {
    case 'confirmed':
    case 'estimated':
      return null // 충분한 데이터 — 뱃지 불필요
    case 'reference':
      return { label: '참고', className: 'border-amber-300 text-amber-600' }
    default:
      return { label: '데이터 부족', className: 'border-gray-300 text-gray-500' }
  }
}
