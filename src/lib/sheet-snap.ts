/**
 * 바텀시트 스냅 포인트 유틸리티.
 * 시트 높이를 px 단위로 다루며, 드래그 종료 시 가장 가까운 스냅 위치를 반환한다.
 */

export interface SnapPoints {
  mid: number
  full: number
}

/** 후보 스냅 높이들 중 currentHeight와 가장 가까운 값을 반환 */
export function nearestSnap(currentHeight: number, snaps: SnapPoints): number {
  const candidates = [snaps.mid, snaps.full]
  let best = candidates[0]
  let bestDist = Math.abs(currentHeight - best)
  for (const candidate of candidates) {
    const dist = Math.abs(currentHeight - candidate)
    if (dist < bestDist) {
      best = candidate
      bestDist = dist
    }
  }
  return best
}
