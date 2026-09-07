import { describe, expect, it } from 'vitest'
import {
  detectRegionConflict,
  extractCity,
  extractNameKeywords,
  extractProvince,
  extractRegion,
  getMatchConfidence,
  hasSpecificIdentifier,
  isAmbiguousName,
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
    expect(scoreBlogRelevance('맛집 추천', '강남 맛집 리뷰', '강남역 주차장', '서울 강남구')).toBe(
      0,
    )
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

// ── 2026-09-04 실측 오매칭 사례 ─────────────────────────────
//
// '중앙시장'(경상북도 김천시) 한 곳에 강릉·속초·통영·문경 중앙시장 글이 131건 붙어 있었다.
// 당시 채점 함수는 김천 글과 강릉 글에 똑같이 60점을 줬다.
describe('동명이지(同名異地) 오매칭 차단', () => {
  const 김천중앙시장 = { name: '중앙시장', address: '경상북도 김천시 중앙시장3길 12' }

  it('이름이 흔한 시설이면 고유 식별자로 보지 않는다', () => {
    expect(hasSpecificIdentifier('중앙시장')).toBe(false)
    expect(hasSpecificIdentifier('평생학습관')).toBe(false)
    expect(hasSpecificIdentifier('국민체육센터')).toBe(false)
    expect(hasSpecificIdentifier('문경시 문화예술회관')).toBe(false)
  })

  it('고유 명칭은 그대로 통과시킨다', () => {
    expect(hasSpecificIdentifier('마장축산물시장 주차장')).toBe(true)
    expect(hasSpecificIdentifier('서울대공원 공영 주차장')).toBe(true)
    expect(hasSpecificIdentifier('롯데월드몰 주차장')).toBe(true)
  })

  it('다른 도시 글은 임계값 아래로 떨어진다', () => {
    for (const title of [
      '강릉 중앙시장 주차장 먹거리 회센터 운영시간 맛집 추천',
      '속초중앙시장 먹거리 막걸리술빵 오징어순대 주차장 총정리',
      '통영중앙시장 동피랑 공영주차장',
      '문경 중앙시장 공영주차장 편안하게 1시간 무료 이용하세요',
    ]) {
      const score = scoreBlogRelevance(title, '', 김천중앙시장.name, 김천중앙시장.address)
      expect(score, title).toBeLessThan(40)
    }
  })

  it('같은 도시 글은 살린다', () => {
    const score = scoreBlogRelevance(
      '김천 중앙시장 주차장 요금 안내',
      '김천시 중앙시장 공영주차장 이용 후기',
      김천중앙시장.name,
      김천중앙시장.address,
    )
    expect(score).toBeGreaterThanOrEqual(40)
  })

  it('주차장 이름에 든 지역명은 충돌로 보지 않는다', () => {
    // 서울대공원은 경기 과천 소재다. 이름의 '서울'을 충돌로 세면 맞는 글이 떨어진다.
    expect(
      detectRegionConflict(
        '서울대공원 주차장 완벽 가이드, 주말 주차 꿀팁까지!',
        '서울대공원 공영 주차장',
        '경기도 과천시 막계동 270-1',
      ),
    ).toBe(false)
    // 세종대왕릉은 경기 여주 소재다.
    expect(
      detectRegionConflict(
        '[여주여행] 여주 세종대왕릉, 영릉 주차와 입장료',
        '세종대왕릉주차장',
        '경기 여주시 세종대왕면 영릉로 269',
      ),
    ).toBe(false)
  })

  it('한글 안에 우연히 든 지역명은 세지 않는다', () => {
    // '공영주차장' 의 '영주', '고양이' 의 '고양'
    expect(
      detectRegionConflict('공영주차장 이용 안내', '중앙시장', '경상북도 김천시 중앙시장3길 12'),
    ).toBe(false)
    expect(
      detectRegionConflict('고양이 카페 주차', '중앙시장', '경상북도 김천시 중앙시장3길 12'),
    ).toBe(false)
  })

  it('행정 접미사가 붙어도 지역명으로 읽는다', () => {
    expect(
      detectRegionConflict(
        '예천군 제1공영주차장 운영 중단',
        '경주시 제1공영주차장',
        '경상북도 경주시 중앙로 47번길 13',
      ),
    ).toBe(true)
  })

  it('긴 주소 표기에서도 시·도를 읽는다', () => {
    // 이전 구현은 짧은 형태만 봐서 '경상북도'·'강원특별자치도' 에서 빈 값을 돌려줬다.
    expect(extractProvince('경상북도 김천시 중앙시장3길 12')).toBe('경북')
    expect(extractProvince('강원특별자치도 춘천시 신북읍')).toBe('강원')
    expect(extractProvince('서울특별시 광진구 능동로 216')).toBe('서울')
    expect(extractProvince('경북 김천시')).toBe('경북')
  })
})

// ── 2026-09-07 실측 오매칭 사례 (2차) ────────────────────────
//
// 1차 수정(#174)의 `GENERIC_FACILITIES` 손목록은 그때 관측한 이름만 담고 있었다.
// 그래서 '국립공원주차장'·'호수공원 주차장'처럼 목록에 없는 전국구 이름이 여전히
// 분기 A(지역 검사 생략)로 갔다. 실측: 설악산(강원) 글이 전남 구례 lot 에
// score 80 / confidence 'high' 로 붙었고, high 는 AI 검증 없이 바로 INSERT 되는 등급이다.
describe('전국구 동명 이름 (분포 기반 판정)', () => {
  it('전국에 겹치는 이름은 모호로 잡는다', () => {
    expect(isAmbiguousName('국립공원주차장')).toBe(true)
    expect(isAmbiguousName('호수공원 주차장')).toBe(true)
    expect(isAmbiguousName('시외버스터미널주차장')).toBe(true)
  })

  it('한 지역에만 있는 고유 이름은 건드리지 않는다', () => {
    expect(isAmbiguousName('타임스퀘어 주차장')).toBe(false)
    expect(isAmbiguousName('IFC몰 주차장')).toBe(false)
    expect(isAmbiguousName('롯데월드몰 주차장')).toBe(false)
  })

  it('다른 지역 글은 등급까지 떨어뜨린다 (점수만이 아니라)', () => {
    const { confidence } = getMatchConfidence(
      '설악산 국립공원 주차장 후기',
      '주차 편했어요 국립공원주차장 넓어요',
      '국립공원주차장',
      '전라남도 구례군 마산면',
    )
    expect(confidence).not.toBe('high')
  })

  it('지역 고유 이름은 여전히 high 로 통과한다', () => {
    for (const [name, address, title] of [
      ['타임스퀘어 주차장', '서울 영등포구 영중로 15', '타임스퀘어 주차장 후기 주차'],
      ['IFC몰 주차장', '서울 영등포구 국제금융로 10', 'IFC몰 주차장 다녀옴 주차'],
    ] as const) {
      expect(getMatchConfidence(title, '주차 편했어요', name, address).confidence, name).toBe(
        'high',
      )
    }
  })
})

describe('지역 충돌 — 같은 도(道) 안의 다른 도시', () => {
  const 강릉중앙시장 = { name: '중앙시장', address: '강원특별자치도 강릉시 금성로 21' }

  it('도 이름을 언급해도 다른 시·군 글이면 충돌이다', () => {
    // 예전에는 '강원도' 한 단어가 자기 도 확인으로 읽혀 검사를 통과시켰다.
    expect(
      detectRegionConflict(
        '강원도 속초 중앙시장 먹거리 주차장 후기',
        강릉중앙시장.name,
        강릉중앙시장.address,
      ),
    ).toBe(true)
  })

  it('자기 시·군 글은 통과시킨다', () => {
    expect(
      detectRegionConflict('강릉 중앙시장 주차 후기', 강릉중앙시장.name, 강릉중앙시장.address),
    ).toBe(false)
  })

  it('특별·광역시 lot 은 광역 단위를 확인 근거로 쓴다', () => {
    // 시·군이 없는 주소라 확인 토큰이 비면 지방 도시를 스친 글까지 전부 충돌이 된다.
    const ifc = { name: 'IFC몰 주차장', address: '서울특별시 영등포구 국제금융로 10' }
    expect(detectRegionConflict('서울 여의도 IFC몰 주차 후기', ifc.name, ifc.address)).toBe(false)
    expect(detectRegionConflict('부산 해운대 다녀와서 주차', ifc.name, ifc.address)).toBe(true)
  })
})

describe('extractCity 주소 파싱', () => {
  it('도 없이 시작하거나 시·군에서 끝나는 주소도 읽는다', () => {
    expect(extractCity('김천시 중앙시장3길 12')).toBe('김천')
    expect(extractCity('충청남도 예산군')).toBe('예산')
  })

  it('기존 표기도 그대로 읽는다', () => {
    expect(extractCity('경상북도 김천시 중앙시장3길 12')).toBe('김천')
    expect(extractCity('서울특별시 강남구 역삼동')).toBe('')
  })
})

// ── 2026-09-07 실측: 행정구역 키워드가 이름 매칭을 통과시키던 문제 ──
//
// `extractNameKeywords` 가 '구로구청' 에서 '구로구' 를, '울산광역시 …' 에서 '울산광역시' 를
// 만들어, 그 지역 아무 글이나 "이름이 맞다"고 통과했다. 오염의 79%가 이 부류(wrong_lot)였다.
describe('행정구역 키워드로는 이름 매칭이 성립하지 않는다', () => {
  it('잘린 지역 조각은 키워드로 만들지 않는다', () => {
    expect(extractNameKeywords('구로구청 주차장')).not.toContain('구로구')
  })

  it('지역명만 겹치는 글은 떨어뜨린다', () => {
    for (const [name, address, title] of [
      [
        '구로구청 주차장',
        '서울특별시 구로구 가마산로 245',
        '구로구 신도림동 무료·공영주차장 위치·요금 안내',
      ],
      [
        '울산광역시 학생교육원 두남학교 주차장',
        '울산 울주군 두서면 구량차리로 1',
        '울산광역시 울주군 상북면 공영주차장 요금 주말 무료',
      ],
    ] as const) {
      expect(getMatchConfidence(title, '주차 요금', name, address).confidence, name).toBe('none')
    }
  })

  it('실제 그 주차장 글은 살린다', () => {
    expect(
      getMatchConfidence(
        '구로구청 주차장 주차 후기 무료',
        '주차 편했어요',
        '구로구청 주차장',
        '서울특별시 구로구 가마산로 245',
      ).confidence,
    ).toBe('high')
  })

  it('동 이름이 곧 시설명인 주차장은 건드리지 않는다', () => {
    // '고등동공영주차장'·'연동공영주차장' 은 동 이름 말고 정체성이 없다.
    // 시·도 단위와 달리 동 단위는 시설을 특정할 수 있으므로 막으면 안 된다.
    for (const [name, address, title] of [
      ['고등동공영주차장', '경기도 성남시 수정구 고등동', '성남 고등동 공영주차장(무인) 주차요금'],
      ['연동공영주차장', '제주특별자치도 제주시 연동 2', '연동 공영주차장 주차'],
    ] as const) {
      expect(getMatchConfidence(title, '주차 요금 안내', name, address).confidence, name).not.toBe(
        'none',
      )
    }
  })
})
