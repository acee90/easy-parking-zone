import { describe, expect, it } from 'vitest'
import { detectSummaryPollution, hangulRatio, MAX_SUMMARY_LENGTH } from './summary-guard'

/**
 * 픽스처는 전부 2026-08-04 운영 D1에서 실제로 노출되고 있던 값이다.
 * (합성 예시로 바꾸지 말 것 — 이 가드는 실제 오염 형태를 잡으려고 만들었다)
 */

describe('detectSummaryPollution — 실제 오염 데이터', () => {
  it('맨 URL이 섞인 네이버 플레이스 스크랩을 잡는다 (현대백화점 대구점 사례)', () => {
    // 기존 가드가 전부 우회당한 케이스: 592자(800 미만), 줄바꿈 0, `](` 2회뿐,
    // `![](` 없음, 줄머리 `#` 없음 → 문법 기반 패턴은 모두 미탐지. 맨 URL만이 신호였다.
    const s =
      '(https://m.place.naver.com/place/1045354581/review/visitor) # 현대백화점 더현대 대구 주차장 ' +
      '(https://g-place.pstatic.net/assets/shared/images/icon_default_profile.png) 마이플레이스](https://m.place.naver.com/my) ' +
      '현대백화점 더현대 대구 주차장주차장 별점4.'
    expect(detectSummaryPollution(s)).toBe('artifact:url')
  })

  it('제로폭 공백이 섞인 네이버 블로그 원문을 잡는다', () => {
    const s =
      '야외주차장 넓고, 1층에 하나로마트 있어서 애들 간식이랑 필요한것도 샀어요~ ​ ​ ​ ' +
      '함평천지한우프라자 2층 한우명품식당 엘리베이터나 계단으로 올라가시면 됩니다'
    expect(detectSummaryPollution(s)).toBe('artifact:zero_width')
  })

  it('스킴이 잘려 도메인 꼬리만 남은 URL을 잡는다', () => {
    expect(
      detectSummaryPollution(
        'com/grandie126/223990027323) 가 목차 주소 운영시간 주차 요금안내 공영주차장은 말 그대로 시나 구 등 지방자치단체가 운영하는 시설을 말합니다',
      ),
    ).toBe('artifact:orphan_url_tail')
    expect(
      detectSummaryPollution(
        '더 많은 여행지가 궁금하다면. com 02haeun ) 신트리공원 공영주차장 예전에는 지상에만 공영주차장이 있어서 자리도 없고 주차 공간도 너무 좁았습니다',
      ),
    ).toBe('artifact:orphan_url_tail')
  })

  it('마크다운 강조/링크 잔재를 잡는다', () => {
    expect(
      detectSummaryPollution('주차 요금 감면정책 **공영주차장은 말 그대로 지자체가 운영합니다**'),
    ).toBe('artifact:markdown_bold_residue')
    expect(
      detectSummaryPollution('[ 카테고리 이동 ]( 안동카페 임청각 근처 과일전문카페 오즈베'),
    ).toBe('artifact:markdown_link_residue')
  })

  it('URL 쿼리 파라미터 잔재를 잡는다', () => {
    expect(
      detectSummaryPollution('blogId=yisohee&categoryNo=72 광성주차장 이용 후기를 남깁니다'),
    ).toBe('artifact:query_param')
  })

  it('사이트 네비게이션 덤프를 잡는다', () => {
    expect(
      detectSummaryPollution(
        'Skip to content 코리아인포럼 Menu Menu 홈 꿀 정보 유용한 정보 롯데백화점 노원점 주차정보와 휴무일',
      ),
    ).toBe('chrome:site_skip_nav')
    expect(
      detectSummaryPollution(
        '컨텐츠로 건너뛰기 아이트리 Menu 생활꿀팁 일기예보 교통 여행 복지 건강',
      ),
    ).toBe('chrome:site_skip_nav')
  })

  it('meta-only 상투구를 잡는다', () => {
    expect(
      detectSummaryPollution('해당 주차장의 상세 정보를 제공합니다. 방문 전 참고하시기 바랍니다.'),
    ).toBe('chrome:meta_only')
  })

  it('집계사이트/위젯 스크랩을 마크다운 강조 잔재로 잡는다', () => {
    expect(
      detectSummaryPollution(
        '총**189** 명이 열람하였으며, **0** 개의 리뷰가 있습니다. 초롱공원길 공영주차장 초입',
      ),
    ).toBe('artifact:markdown_bold_residue')
    expect(detectSummaryPollution('서울 ⛅ **30°** 미세 좋음 부산 ☀️ **33°** 미세 좋음')).toBe(
      'artifact:markdown_bold_residue',
    )
  })

  it('한글 비율이 낮은 덩어리를 잡는다', () => {
    expect(
      detectSummaryPollution('parking lot info AAA BBB CCC DDD EEE FFF GGG 주차 12345 xyz'),
    ).toBe('low_hangul')
  })

  it(`${MAX_SUMMARY_LENGTH}자를 넘으면 원문 복사로 본다`, () => {
    expect(detectSummaryPollution('가'.repeat(MAX_SUMMARY_LENGTH + 1))).toBe('too_long')
  })
})

describe('detectSummaryPollution — 정상 요약은 통과시킨다', () => {
  it('사양대로 쓰인 요약을 통과시킨다', () => {
    const s =
      '롯데백화점 미아점의 주차장은 유료로 운영되고 있으며, 방문객들에게 구매 금액에 따라 할인 혜택을 제공합니다. ' +
      '고객이 매장에서 일정 금액 이상을 구매하면 무료 또는 할인이 가능한 주차권이 제공됩니다. ' +
      '주차요금은 기본 30분 무료 이후 10분당 1,000원으로 책정되어 있어, 방문 전에 확인하면 불필요한 비용을 줄일 수 있습니다.'
    expect(detectSummaryPollution(s)).toBeNull()
  })

  it('짧아도 읽을 수 있는 문장은 오염으로 보지 않는다 (길이 정책은 호출부 책임)', () => {
    expect(detectSummaryPollution('심청각 주차장 넓고 편함')).toBeNull()
  })

  it('숫자·기호가 섞인 요금 안내를 오탐하지 않는다', () => {
    const s =
      '기본 30분 1,000원이고 이후 10분당 500원이 추가됩니다. 1일 최대 15,000원까지만 부과되며 ' +
      '경차와 장애인 차량은 50% 감면됩니다. 평일 09:00~18:00 운영합니다.'
    expect(detectSummaryPollution(s)).toBeNull()
  })

  it('빈 값은 판정 대상이 아니다', () => {
    expect(detectSummaryPollution(null)).toBeNull()
    expect(detectSummaryPollution(undefined)).toBeNull()
    expect(detectSummaryPollution('')).toBeNull()
  })
})

describe('hangulRatio', () => {
  it('공백을 제외하고 한글 비율을 센다', () => {
    expect(hangulRatio('주차장')).toBe(1)
    expect(hangulRatio('주차 abcd')).toBeCloseTo(2 / 6, 5)
    expect(hangulRatio('')).toBe(0)
  })
})
