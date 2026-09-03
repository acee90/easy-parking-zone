import { describe, expect, it } from 'vitest'
import { clusterByRadius } from './cluster'

const base = { lat: 37.5054, lng: 127.1067 }
// 위도 0.0001도 ≈ 11m
const at = (dLat: number, dLng = 0) => ({ lat: base.lat + dLat, lng: base.lng + dLng })

describe('clusterByRadius', () => {
  it('50m 안의 후보는 근거가 많은 쪽의 alias 가 된다', () => {
    const r = clusterByRadius([
      { key: 'dior', name: '디올 롯데백화점 본점', evidenceCount: 1, ...at(0) },
      { key: 'lotte', name: '롯데백화점 본점', evidenceCount: 9, ...at(0.0002) }, // 22m
    ])
    expect(r.representatives).toEqual(['lotte'])
    expect(r.representativeOf.get('dior')).toBe('lotte')
    expect(r.representativeOf.get('lotte')).toBe('lotte')
  })

  it('근거 수가 같으면 이름이 짧은 쪽이 대표다', () => {
    const r = clusterByRadius([
      { key: 'long', name: '스타필드 시티 위례 지하 1층', evidenceCount: 2, ...at(0) },
      { key: 'short', name: '스타필드 위례', evidenceCount: 2, ...at(0.0001) },
    ])
    expect(r.representatives).toEqual(['short'])
  })

  it('경계선 양쪽의 5m 이웃도 한 클러스터다 (고정 격자와 다른 점)', () => {
    const r = clusterByRadius([
      { key: 'a', name: 'a', evidenceCount: 1, ...at(0) },
      { key: 'b', name: 'b', evidenceCount: 1, ...at(0.00005) }, // ≈5.5m
    ])
    expect(r.representatives).toHaveLength(1)
  })

  it('50m 를 넘으면 각자 대표다', () => {
    const r = clusterByRadius([
      { key: 'a', name: 'a', evidenceCount: 1, ...at(0) },
      { key: 'b', name: 'b', evidenceCount: 1, ...at(0.001) }, // ≈110m
    ])
    expect(r.representatives.sort()).toEqual(['a', 'b'])
  })

  it('대표는 먼저 뽑힌 것 기준이라 체인으로 번지지 않는다', () => {
    // a—b 40m, b—c 40m, a—c 80m. b 가 대표면 a,c 둘 다 흡수되지만 a 가 대표면 c 는 남는다
    const r = clusterByRadius([
      { key: 'a', name: 'a', evidenceCount: 3, ...at(0) },
      { key: 'b', name: 'b', evidenceCount: 1, ...at(0.00036) },
      { key: 'c', name: 'c', evidenceCount: 1, ...at(0.00072) },
    ])
    expect(r.representatives.sort()).toEqual(['a', 'c'])
    expect(r.representativeOf.get('b')).toBe('a')
  })
})
