/**
 * 지도 목록용 최근접 후보 고르기 (B-1).
 *
 * 서버에서 `ORDER BY 거리` 로 정렬하면 bounds 안 전부를 읽어 rows_read 가 3.5~33배로 뛴다
 * (09-11 실측: z14 1,314 → 4,604, 서울 전역 738 → 24,502). 클라이언트는 이미 전 주차장의
 * 경량 좌표를 메모리에 들고 있으므로 여기서 가까운 후보만 골라 id 로 조회한다.
 */

export interface PointLike {
  id: string
  lat: number
  lng: number
}

export interface BoundsLike {
  south: number
  north: number
  west: number
  east: number
}

/** 거리 비교용 제곱 거리 (km², 한국 위도 근사). 정렬에만 쓰므로 sqrt 는 생략한다. */
export function squaredKm(lat: number, lng: number, center: { lat: number; lng: number }): number {
  const dy = (lat - center.lat) * 111.0
  const dx = (lng - center.lng) * 88.0
  return dx * dx + dy * dy
}

/** bounds 안 점 중 center 에서 가까운 n 개의 id (가까운 순). */
export function pickNearestIds<P extends PointLike>(
  points: readonly P[],
  bounds: BoundsLike,
  center: { lat: number; lng: number },
  n: number,
): string[] {
  const inside: Array<{ id: string; d: number }> = []
  for (const p of points) {
    if (p.lat < bounds.south || p.lat > bounds.north || p.lng < bounds.west || p.lng > bounds.east)
      continue
    inside.push({ id: p.id, d: squaredKm(p.lat, p.lng, center) })
  }
  inside.sort((a, b) => a.d - b.d)
  return inside.slice(0, n).map((x) => x.id)
}
