import { describe, expect, it } from 'vitest'
import { getBearing } from './geo-utils'

describe('getBearing', () => {
  const base = { lat: 37.5, lng: 127 }

  it('정북은 0도', () => {
    expect(getBearing(base.lat, base.lng, base.lat + 0.01, base.lng)).toBeCloseTo(0, 1)
  })

  it('정동은 90도', () => {
    expect(getBearing(base.lat, base.lng, base.lat, base.lng + 0.01)).toBeCloseTo(90, 1)
  })

  it('정남은 180도', () => {
    expect(getBearing(base.lat, base.lng, base.lat - 0.01, base.lng)).toBeCloseTo(180, 1)
  })

  it('정서는 270도', () => {
    expect(getBearing(base.lat, base.lng, base.lat, base.lng - 0.01)).toBeCloseTo(270, 1)
  })

  it('항상 0 이상 360 미만으로 정규화한다', () => {
    for (const [dLat, dLng] of [
      [0.01, 0.01],
      [-0.01, 0.01],
      [-0.01, -0.01],
      [0.01, -0.01],
    ]) {
      const b = getBearing(base.lat, base.lng, base.lat + dLat, base.lng + dLng)
      expect(b).toBeGreaterThanOrEqual(0)
      expect(b).toBeLessThan(360)
    }
  })

  // 이마트 월계점 실측: 파노라마(37.6261299, 127.061496) → 주차장(37.6265483, 127.0618877)
  it('실측 사례의 방위각을 재현한다 (이마트 월계점 36.6도)', () => {
    expect(getBearing(37.6261299, 127.061496, 37.6265483313738, 127.061887713472)).toBeCloseTo(
      36.6,
      0,
    )
  })
})
