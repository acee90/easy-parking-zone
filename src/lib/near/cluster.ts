/**
 * 좌표 클러스터링 (#166, 기획 6-3절)
 *
 * 같은 건물의 테넌트를 각각 페이지로 만들면 서로 0m 인 중복 페이지가 생긴다 (경쟁사가 실제로 그렇다).
 * 근거가 많은 후보부터 훑으며, 이미 뽑힌 대표 중 반경 안에 있으면 그 대표의 alias 로 흡수한다.
 * 고정 격자를 쓰지 않는 이유: 격자 경계선을 사이에 둔 5m 이웃이 갈라진다.
 */

import { distanceMeters } from './gate'

export interface ClusterInput {
  key: string
  name: string
  lat: number
  lng: number
  /** 정렬 기준. 많을수록 먼저 대표가 된다 */
  evidenceCount: number
}

export interface ClusterResult {
  /** key → 대표 key. 대표는 자기 자신 */
  representativeOf: Map<string, string>
  representatives: string[]
}

export function clusterByRadius(items: ClusterInput[], radiusM = 50): ClusterResult {
  const ordered = [...items].sort(
    (a, b) =>
      b.evidenceCount - a.evidenceCount ||
      a.name.length - b.name.length ||
      a.key.localeCompare(b.key),
  )
  const reps: ClusterInput[] = []
  const representativeOf = new Map<string, string>()

  for (const item of ordered) {
    const near = reps.find((r) => distanceMeters(r.lat, r.lng, item.lat, item.lng) <= radiusM)
    if (near) {
      representativeOf.set(item.key, near.key)
    } else {
      reps.push(item)
      representativeOf.set(item.key, item.key)
    }
  }
  return { representativeOf, representatives: reps.map((r) => r.key) }
}
