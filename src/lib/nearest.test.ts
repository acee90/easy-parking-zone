import { describe, expect, it } from 'vitest'
import { pickNearestIds } from './nearest'

const bounds = { south: 37.5, north: 37.6, west: 126.9, east: 127.0 }
const center = { lat: 37.55, lng: 126.95 }

describe('pickNearestIds', () => {
  it('bounds 안 점만, 중심에서 가까운 순으로 n 개', () => {
    const points = [
      { id: 'far', lat: 37.59, lng: 126.99 },
      { id: 'near', lat: 37.5501, lng: 126.9501 },
      { id: 'mid', lat: 37.56, lng: 126.96 },
      { id: 'outside', lat: 37.7, lng: 126.95 },
    ]
    expect(pickNearestIds(points, bounds, center, 2)).toEqual(['near', 'mid'])
  })

  it('경도 1도가 위도 1도보다 짧은 것을 반영한다', () => {
    // 같은 도(degree) 차이라도 경도 방향이 더 가깝다 (88km vs 111km)
    const points = [
      { id: 'lat-off', lat: 37.56, lng: 126.95 },
      { id: 'lng-off', lat: 37.55, lng: 126.96 },
    ]
    expect(pickNearestIds(points, bounds, center, 1)).toEqual(['lng-off'])
  })

  it('bounds 안 점이 n 보다 적으면 있는 만큼', () => {
    expect(pickNearestIds([{ id: 'a', lat: 37.55, lng: 126.95 }], bounds, center, 250)).toEqual([
      'a',
    ])
  })
})
