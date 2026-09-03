import { describe, expect, it } from 'vitest'
import { extractHost, isAggregatorUrl } from './aggregator-domains'

describe('extractHost', () => {
  it('스킴·www·경로·포트를 걷어낸다', () => {
    expect(extractHost('https://www.placeview.co.kr/id/ABC')).toBe('placeview.co.kr')
    expect(extractHost('http://jucha.kr:8080/search?x=1')).toBe('jucha.kr')
    expect(extractHost('https://Parking.Loveash.KR/parking/1')).toBe('parking.loveash.kr')
    expect(extractHost('jucha.kr/a/b')).toBe('jucha.kr')
  })
  it('빈 값은 null', () => {
    expect(extractHost('')).toBeNull()
    expect(extractHost('   ')).toBeNull()
  })
})

describe('isAggregatorUrl', () => {
  it('정보 모음 사이트를 잡는다', () => {
    expect(isAggregatorUrl('https://www.placeview.co.kr/id/OTMxNDU4NTk3')).toBe(true)
    expect(isAggregatorUrl('https://dodam-platform.com/parking-lots/11313')).toBe(true)
    expect(isAggregatorUrl('https://jucha.kr/search/place/parkinglot?code=161-2-000155')).toBe(true)
    expect(isAggregatorUrl('https://parking.worldtourlist.com/parking-detail.php?id=1')).toBe(true)
  })
  it('우리 사이트도 막는다 (자기 크롤 되먹임 방지)', () => {
    expect(isAggregatorUrl('https://easy-parking.xyz/wiki/foo')).toBe(true)
  })
  it('서브도메인도 잡는다', () => {
    expect(isAggregatorUrl('https://news.k114.co.kr/a')).toBe(true)
  })
  it('진짜 후기는 통과시킨다', () => {
    expect(isAggregatorUrl('https://blog.naver.com/soohee11/222877039998')).toBe(false)
    expect(isAggregatorUrl('https://m.blog.naver.com/zero-and-tj/223540506405')).toBe(false)
    expect(isAggregatorUrl('https://cafe.naver.com/xxx/123')).toBe(false)
    expect(isAggregatorUrl('https://tour.boemul.com/2025/05/blog-post_59.html')).toBe(false)
  })
  it('비슷하지만 다른 도메인은 통과 (부분일치 오탐 방지)', () => {
    expect(isAggregatorUrl('https://notjucha.kr/a')).toBe(false)
    expect(isAggregatorUrl('https://jucha.kr.evil.com/a')).toBe(false)
  })
  it('빈 값은 false', () => {
    expect(isAggregatorUrl(null)).toBe(false)
    expect(isAggregatorUrl(undefined)).toBe(false)
    expect(isAggregatorUrl('')).toBe(false)
  })
})
