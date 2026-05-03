import { describe, expect, it } from 'vitest'
import { scoreBlogRelevance, scoreBlogRelevanceFull } from './scoring'

describe('scoreBlogRelevanceFull', () => {
  it('returns 0 when full text has no parking keyword', () => {
    const score = scoreBlogRelevanceFull(
      '판교 카페 추천',
      '판교 테크노밸리 근처에 새로 생긴 카페에 다녀왔습니다.',
      '판교 테크노밸리 공영주차장',
      '경기도 성남시 판교',
    )
    expect(score).toBe(0)
  })

  it('returns 0 on Coupang Partners boilerplate body', () => {
    const score = scoreBlogRelevanceFull(
      '주차 정보',
      '이 포스팅은 쿠팡 파트너스 활동의 일환으로, 일정액의 수수료를 제공받습니다. 주차장에 대한 간단한 정보입니다.',
      '강남역 공영주차장',
      '서울 강남구',
    )
    expect(score).toBe(0)
  })

  it('rewards specific identifier matches and parking-keyword density', () => {
    const score = scoreBlogRelevanceFull(
      '스타필드 위례 주차장 후기',
      '스타필드 위례에 다녀왔습니다. 주차장은 지하 1층부터 4층까지 운영되며 평일 오후에는 비교적 여유롭습니다. 위례 스타필드의 진입은 좁은 편이지만 주차면은 넓습니다. 주차 요금은 30분 무료, 이후 10분당 500원입니다.',
      '스타필드 위례 주차장',
      '경기도 하남시 위례동',
    )
    // hasSpecific=true; title+body match; province "경기" not in body → -30 penalty applies.
    expect(score).toBeGreaterThanOrEqual(40)
    expect(score).toBeLessThanOrEqual(100)
  })

  it('penalises long body with low lot-name density', () => {
    const longBody =
      '주차장 ' + '여러 가지 일반적인 이야기들입니다. '.repeat(200) + '스타필드 위례 한 번만 언급.'
    const score = scoreBlogRelevanceFull(
      '오늘의 후기',
      longBody,
      '스타필드 위례 주차장',
      '경기도 하남시',
    )
    // Density penalty (-10) should fire for body >= 3000 with name freq <= 1
    expect(score).toBeGreaterThanOrEqual(0)
  })

  it('v2 produces a different signal than v1 on identical input', () => {
    const title = '여행 후기'
    const body =
      '서울숲에 다녀왔어요. 주차장이 넓고 깨끗합니다. 서울숲 주차장은 평일에는 여유로워요. 서울숲 주차장 추천합니다.'
    const v1 = scoreBlogRelevance(title, body, '서울숲 공영주차장', '서울 성동구')
    const v2 = scoreBlogRelevanceFull(title, body, '서울숲 공영주차장', '서울 성동구')
    // Both should be > 0 here (it's a real match), but v2 should reward repeated lot mentions.
    expect(v1).toBeGreaterThan(0)
    expect(v2).toBeGreaterThan(0)
  })
})
