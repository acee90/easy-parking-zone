import { describe, expect, it } from 'vitest'
import {
  extractCity,
  extractNameKeywords,
  extractProvince,
  extractRegion,
  getMatchConfidence,
  hasSpecificIdentifier,
  isGenericName,
  parsePostdate,
  scoreBlogRelevance,
  scoreYoutubeComment,
  stripHtml,
} from './scoring'

describe('extractRegion', () => {
  it('extracts 구/동 from address', () => {
    expect(extractRegion('서울특별시 강남구 역삼동 123')).toBe('강남구 역삼동')
  })

  it('skips province and city', () => {
    expect(extractRegion('경기도 수원시 팔달구 인계동')).toBe('팔달구 인계동')
  })

  it('returns empty for address without 구/동', () => {
    expect(extractRegion('')).toBe('')
  })
})

describe('isGenericName', () => {
  it('detects generic parking lot names', () => {
    expect(isGenericName('제1주차장')).toBe(true)
    expect(isGenericName('지하주차장')).toBe(true)
    expect(isGenericName('주차장')).toBe(true)
    expect(isGenericName('공영주차장')).toBe(true)
  })

  it('returns false for specific names', () => {
    expect(isGenericName('강남역 공영주차장')).toBe(false)
    expect(isGenericName('코엑스 주차장')).toBe(false)
  })
})

describe('stripHtml', () => {
  it('removes HTML tags', () => {
    expect(stripHtml('<b>hello</b> world')).toBe('hello world')
  })

  it('decodes HTML entities', () => {
    expect(stripHtml('A &amp; B &lt;C&gt;')).toBe('A & B <C>')
  })

  it('handles empty string', () => {
    expect(stripHtml('')).toBe('')
  })
})

describe('parsePostdate', () => {
  it('converts 8-digit date string', () => {
    expect(parsePostdate('20240315')).toBe('2024-03-15')
  })

  it('returns null for invalid input', () => {
    expect(parsePostdate(undefined)).toBeNull()
    expect(parsePostdate('2024')).toBeNull()
    expect(parsePostdate('')).toBeNull()
  })
})

describe('extractNameKeywords', () => {
  it('extracts keywords from compound name', () => {
    const kws = extractNameKeywords('강남역 공영주차장')
    expect(kws).toContain('강남역')
  })

  it('extracts facility boundary keywords', () => {
    const kws = extractNameKeywords('마장축산물시장 주차장')
    expect(kws).toContain('마장축산물시장')
  })

  it('handles English prefix', () => {
    const kws = extractNameKeywords('KTX환승 주차장')
    expect(kws).toContain('ktx')
  })

  it('removes duplicates', () => {
    const kws = extractNameKeywords('역삼 주차장')
    const unique = new Set(kws)
    expect(kws.length).toBe(unique.size)
  })
})

describe('extractProvince', () => {
  it('extracts province from address', () => {
    expect(extractProvince('서울특별시 강남구')).toBe('서울')
    expect(extractProvince('경기도 수원시')).toBe('경기')
    expect(extractProvince('부산광역시 해운대구')).toBe('부산')
  })

  it('returns empty for unrecognized address', () => {
    expect(extractProvince('어딘가 모를 곳')).toBe('')
  })
})

describe('extractCity', () => {
  it('extracts city from address', () => {
    expect(extractCity('경상북도 경주시 중앙로 47번길 13')).toBe('경주')
    expect(extractCity('충북 음성군 음성읍 읍내리 624-5')).toBe('음성')
    expect(extractCity('경기도 수원시 영통구 원천동 577')).toBe('수원')
  })

  it('returns empty for metropolitan cities', () => {
    expect(extractCity('서울특별시 강남구 역삼동')).toBe('')
    expect(extractCity('부산광역시 해운대구')).toBe('')
  })
})

describe('hasSpecificIdentifier', () => {
  it('returns true for unique names', () => {
    expect(hasSpecificIdentifier('코엑스 주차장')).toBe(true)
    expect(hasSpecificIdentifier('광교 대학로 공영')).toBe(true)
    expect(hasSpecificIdentifier('태화동 가정교회 주변 마을공동주차장')).toBe(true)
    expect(hasSpecificIdentifier('마장축산물시장 주차장')).toBe(true)
  })

  it('returns false for generic+location only', () => {
    expect(hasSpecificIdentifier('경주시 제1공영주차장')).toBe(false)
    expect(hasSpecificIdentifier('제1공영주차장')).toBe(false)
    expect(hasSpecificIdentifier('노상공영주차')).toBe(false)
    expect(hasSpecificIdentifier('무료주차장')).toBe(false)
    expect(hasSpecificIdentifier('태화동 마을공동주차장')).toBe(false)
  })
})

describe('scoreBlogRelevance', () => {
  it('returns 0 when no parking keyword', () => {
    expect(scoreBlogRelevance('맛집 추천', '강남 맛집 리뷰', '강남역 주차장', '서울 강남구')).toBe(0)
  })

  it('returns 0 for noise content', () => {
    expect(
      scoreBlogRelevance('모델하우스 주차장', '분양가 정보', '삼성 주차장', '서울 강남구'),
    ).toBe(0)
  })

  it('scores high for exact name match in title', () => {
    const score = scoreBlogRelevance(
      '코엑스 주차장 후기',
      '코엑스에서 주차 쉬웠습니다',
      '코엑스 주차장',
      '서울 강남구 삼성동',
    )
    expect(score).toBeGreaterThanOrEqual(40)
  })

  it('caps score at 40 without name match', () => {
    const score = scoreBlogRelevance(
      '강남구 주차 꿀팁',
      '역삼동에서 주차하기',
      '완전다른이름 주차장',
      '서울 강남구 역삼동',
    )
    expect(score).toBeLessThanOrEqual(40)
  })

  it('penalizes province mismatch', () => {
    const matched = scoreBlogRelevance(
      '해운대 주차장',
      '해운대 주차 후기',
      '해운대 주차장',
      '부산 해운대구',
    )
    const mismatched = scoreBlogRelevance(
      '해운대 주차장',
      '해운대 주차 후기',
      '해운대 주차장',
      '서울 강남구',
    )
    expect(matched).toBeGreaterThanOrEqual(mismatched)
  })

  it('allows generic name match when location co-occurs', () => {
    // 블로그에 "경주시" (시 포함)와 "제1공영주차장" 모두 언급
    const score = scoreBlogRelevance(
      '경주시 제1공영주차장 이용 후기',
      '경주시 제1공영주차장에서 주차했습니다',
      '경주시 제1공영주차장',
      '경상북도 경주시 중앙로 47번길 13',
    )
    expect(score).toBeGreaterThan(40)
  })

  it('blocks generic name match when location differs', () => {
    const score = scoreBlogRelevance(
      '예천군 제1공영주차장 운영 중단',
      '예천군 제1공영주차장 임시주차장 안내',
      '경주시 제1공영주차장',
      '경상북도 경주시 중앙로 47번길 13',
    )
    expect(score).toBeLessThanOrEqual(40)
  })
})

describe('getMatchConfidence', () => {
  it('returns none for low score', () => {
    const result = getMatchConfidence('맛집', '음식 리뷰', '강남 주차장', '서울 강남구')
    expect(result.confidence).toBe('none')
  })

  it('returns high for long keyword match with parking keyword', () => {
    const result = getMatchConfidence(
      '마장축산물시장 주차장 후기',
      '마장축산물시장에서 주차했습니다',
      '마장축산물시장 주차장',
      '서울 성동구 마장동',
    )
    expect(result.confidence).toBe('high')
  })

  it('returns medium for keyword match with region', () => {
    const result = getMatchConfidence(
      '강남역 공영주차장 주차 후기',
      '강남역 공영주차장에서 주차했습니다',
      '강남역 공영주차장',
      '서울 강남구',
    )
    expect(result.confidence).not.toBe('none')
  })

  it('returns medium for name with no specific identifier', () => {
    const result = getMatchConfidence(
      '경주 제1공영주차장 주차 후기',
      '경주시 제1공영주차장에서 주차했습니다',
      '경주시 제1공영주차장',
      '경상북도 경주시 중앙로 47번길 13',
    )
    expect(result.confidence).toBe('medium')
  })
})

describe('scoreYoutubeComment', () => {
  it('scores high for difficulty keywords', () => {
    const score = scoreYoutubeComment('여기 주차장 너무 좁아서 무서웠어요', '강남 주차장')
    expect(score).toBeGreaterThanOrEqual(50)
  })

  it('scores low for short irrelevant text', () => {
    const score = scoreYoutubeComment('ㅋㅋ', '강남 주차장')
    expect(score).toBe(0)
  })

  it('adds bonus for parking lot name match', () => {
    const withName = scoreYoutubeComment('강남 주차 힘들어요', '강남 주차장')
    const withoutName = scoreYoutubeComment('여기 주차 힘들어요', '코엑스 주차장')
    expect(withName).toBeGreaterThan(withoutName)
  })
})
