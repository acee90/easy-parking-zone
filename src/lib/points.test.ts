import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useSuperCluster } from '@/hooks/useSuperCluster'
import { decodePoints, encodePoint, type ParkingPoint } from './points'

// 서울 일대 3,000곳 (시드 고정, 원본처럼 소수 8자리)
function seoulPoints(): ParkingPoint[] {
  let s = 911
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2 ** 31
    return s / 2 ** 31
  }
  return Array.from({ length: 3000 }, (_, i) => ({
    id: `p${i}`,
    lat: Number((37.45 + rnd() * 0.25).toFixed(8)),
    lng: Number((126.8 + rnd() * 0.35).toFixed(8)),
    score: rnd() < 0.7 ? null : Number((1 + rnd() * 4).toFixed(2)),
  }))
}

describe('points 형식 (B-3)', () => {
  it('인코딩 → 디코딩은 id·score 를 보존하고 좌표만 소수 5자리로 줄인다', () => {
    const p = { id: '413-2-000080', lat: 36.59884803, lng: 127.297507, score: 3.03 }
    expect(encodePoint(p)).toEqual(['413-2-000080', 36.59885, 127.29751, 3.03])
    expect(decodePoints([encodePoint(p)])).toEqual([
      { id: '413-2-000080', lat: 36.59885, lng: 127.29751, score: 3.03 },
    ])
  })

  it('반올림해도 줌 8~15 클러스터 결과가 사실상 같다', () => {
    const raw = seoulPoints()
    const rounded = decodePoints(raw.map(encodePoint))
    const a = renderHook(() => useSuperCluster(raw)).result.current
    const b = renderHook(() => useSuperCluster(rounded)).result.current
    const bbox = { south: 37.4, north: 37.75, west: 126.75, east: 127.2 }
    const summary = (features: ReturnType<typeof a.getClusters>) => {
      let points = 0
      let scoreSum = 0
      for (const f of features) {
        if (f.properties.cluster) {
          points += f.properties.point_count
          scoreSum += f.properties.sum_score
        } else {
          points += 1
          scoreSum += f.properties.score ?? 0
        }
      }
      return { features: features.length, points, scoreSum }
    }
    for (let zoom = 8; zoom <= 15; zoom++) {
      const sa = summary(a.getClusters(bbox, zoom))
      const sb = summary(b.getClusters(bbox, zoom))
      expect(sb.points).toBe(sa.points)
      expect(sb.scoreSum).toBeCloseTo(sa.scoreSum, 6)
      // 경계에 걸린 점 하나가 옆 클러스터로 넘어갈 수는 있다 — 개수 차이 1% 이내
      expect(Math.abs(sb.features - sa.features)).toBeLessThanOrEqual(Math.ceil(sa.features * 0.01))
    }
  })
})
