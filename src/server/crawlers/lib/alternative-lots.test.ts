import { describe, expect, it } from 'vitest'
import { aggregateLotNames, extractLotNames, normalizeLotName } from './alternative-lots'

// 아래 세 문장은 차이나타운공영주차장 후기 14건에서 실제로 반복된 표현이다
const REAL_INCHEON_PORT = '넓고 시간제한이 없는 인천내항 8부두 주차장(무료), 도보 약 10분'
const REAL_SONGWOL = '주말에 자리가 없어 도보 5분 거리 송월동 동화마을 공영주차장으로 갔다'
const REAL_HANJUNG = '공영·민영 요금 총정리 — 한중문화관 공영주차장은 30분 1000원이다'

describe('extractLotNames — 실제 후기 문장', () => {
  it('무료 대안 주차장 이름을 뽑는다', () => {
    expect(extractLotNames(REAL_INCHEON_PORT)).toEqual(['인천내항 8부두 주차장'])
  })

  it('도보 거리 표현 뒤의 이름만 남긴다', () => {
    expect(extractLotNames(REAL_SONGWOL)).toEqual(['송월동 동화마을 공영주차장'])
  })

  it('요금 비교 문장에서 이름을 뽑는다', () => {
    expect(extractLotNames(REAL_HANJUNG)).toEqual(['한중문화관 공영주차장'])
  })

  it('한 글에 여러 주차장이 나오면 모두 뽑는다', () => {
    const text = `${REAL_INCHEON_PORT}. ${REAL_SONGWOL}.`
    expect(extractLotNames(text)).toEqual(['인천내항 8부두 주차장', '송월동 동화마을 공영주차장'])
  })
})

describe('extractLotNames — 지시어·일반명사 배제', () => {
  it('지시어가 붙은 말은 이름이 아니다', () => {
    expect(extractLotNames('이 주차장은 넓다')).toEqual([])
    expect(extractLotNames('그 주차장에 댔다')).toEqual([])
    expect(extractLotNames('해당 주차장은 만차였다')).toEqual([])
    expect(extractLotNames('근처 주차장을 찾아봤다')).toEqual([])
    expect(extractLotNames('주변 주차장이 다 유료다')).toEqual([])
  })

  it('일반명사 단독은 이름이 아니다', () => {
    expect(extractLotNames('공영주차장을 이용했다')).toEqual([])
    expect(extractLotNames('무료주차장이 있으면 좋겠다')).toEqual([])
    expect(extractLotNames('노상주차장은 요금이 싸다')).toEqual([])
    expect(extractLotNames('주차장 입구가 좁다')).toEqual([])
    expect(extractLotNames('공영 주차장 요금은 저렴하다')).toEqual([])
  })

  it('주차장 이야기가 없는 문장에서는 아무것도 뽑지 않는다', () => {
    expect(extractLotNames('차이나타운 짜장면 맛집을 다녀왔다')).toEqual([])
  })

  it('빈 입력은 빈 배열이다', () => {
    expect(extractLotNames('')).toEqual([])
    expect(aggregateLotNames([])).toEqual([])
    expect(aggregateLotNames(['', ''])).toEqual([])
  })
})

describe('extractLotNames — 이름 만들기 규칙', () => {
  it('같은 글에서 같은 이름이 여러 번 나와도 1개로 센다', () => {
    const text = `${REAL_SONGWOL}. 송월동 동화마을 공영주차장은 늘 붐빈다. 결국 송월동 동화마을 공영주차장에 댔다.`
    expect(extractLotNames(text)).toEqual(['송월동 동화마을 공영주차장'])
  })

  it('앞 토큰은 최대 4개까지만 붙인다', () => {
    const names = extractLotNames('인천 중구 송월동 동화마을 공영주차장')
    expect(names).toEqual(['중구 송월동 동화마을 공영주차장'])
  })

  it('일반 수식어가 사이에 끼면 살린다', () => {
    expect(extractLotNames('부평역 공영 주차장에 댔다')).toEqual(['부평역 공영 주차장'])
  })

  it('주차타워도 잡는다', () => {
    expect(extractLotNames('동인천 로터리 주차타워에 댔다')).toEqual(['동인천 로터리 주차타워'])
  })

  it('줄바꿈을 넘어 이름을 이어붙이지 않는다', () => {
    expect(extractLotNames('도착\n주차장 안내')).toEqual([])
  })

  it('부사가 앞에 붙어도 이름에 넣지 않는다', () => {
    expect(extractLotNames('결국 송월동 동화마을 공영주차장에 댔다')).toEqual([
      '송월동 동화마을 공영주차장',
    ])
  })

  it('깨끗한 형태가 같이 관측되면 군더더기가 붙은 쪽을 흡수한다', () => {
    // '예전' 은 사전에 없는 말이라 한 번만 나오면 이름에 붙어버린다.
    // 같은 글에 깨끗한 형태가 있으면 그쪽으로 모인다.
    const names = extractLotNames(
      '송월동 동화마을 공영주차장에 갔다. 예전 송월동 동화마을 공영주차장이 더 낫다.',
    )
    expect(names).toEqual(['송월동 동화마을 공영주차장'])
  })

  it('덧붙은 부분이 길면 다른 주차장으로 남겨둔다', () => {
    const result = aggregateLotNames(['인천내항 8부두 주차장은 무료다', '8부두 주차장에 댔다'])
    expect(result.map((c) => c.normalized).sort()).toEqual(['8부두', '인천내항8부두'])
  })
})

describe('extractLotNames — 실제 블로그 글에서 드러난 오추출', () => {
  it('앞 후보를 버린 자리에서 조사 꼬리부터 다시 잡지 않는다', () => {
    // '근처 주차장' 을 버린 뒤 남은 '은' 부터 이름이 시작돼 "은 대부분 유료고 무료주차장" 이 나왔었다
    expect(extractLotNames('근처 주차장은 대부분 유료고 무료주차장은 8부두밖에 없어요')).toEqual([])
  })

  it('서술어가 붙은 시간 표현을 이름에 끌어들이지 않는다', () => {
    expect(
      extractLotNames('오전 10시쯤 도착했는데 차이나타운공영주차장은 이미 만차였어요'),
    ).toEqual(['차이나타운공영주차장'])
  })

  it('방위 표현은 이름에서 뺀다', () => {
    expect(extractLotNames('자유공원 아래쪽 신포동 공영주차장도 괜찮다')).toEqual([
      '신포동 공영주차장',
    ])
  })

  it('무료 표시는 줄을 넘어가지 않는다', () => {
    const text = '근처에 무료주차장이 하나 있어요.\n신포동 공영주차장도 괜찮다고 하네요.'
    const [candidate] = aggregateLotNames([text])
    expect(candidate.normalized).toBe('신포동')
    expect(candidate.isFreeHint).toBe(false)
  })
})

describe('extractLotNames — 자리 종류는 이름이 아니다', () => {
  it('이용 대상으로 나눈 구획은 후보가 아니다', () => {
    expect(extractLotNames('입구 옆에 장애인 전용 주차장이 두 칸 있어요')).toEqual([])
    expect(extractLotNames('경차 주차장은 지하 2층에 있습니다')).toEqual([])
    expect(extractLotNames('거주자우선주차장이라 외부 차량은 못 댑니다')).toEqual([])
    expect(extractLotNames('직원 주차장 말고 방문객 주차장으로 가세요')).toEqual([])
    expect(extractLotNames('전기차 주차장에 충전기가 있어요')).toEqual([])
  })

  it('고유명이 함께 있으면 자리 종류가 붙어도 살린다', () => {
    expect(extractLotNames('롯데몰 경차 주차장에 댔다')).toEqual(['롯데몰 경차 주차장'])
  })
})

describe('aggregateLotNames', () => {
  it('여러 글의 언급 건수를 센다', () => {
    const result = aggregateLotNames([
      REAL_INCHEON_PORT,
      '인천내항 8부두 주차장이 훨씬 편하다',
      REAL_SONGWOL,
    ])
    expect(result).toHaveLength(2)
    expect(result[0]).toMatchObject({
      name: '인천내항 8부두 주차장',
      normalized: '인천내항8부두',
      count: 2,
    })
    expect(result[1]).toMatchObject({ normalized: '송월동동화마을', count: 1 })
  })

  it('한 글에서 반복된 이름은 1건으로 센다', () => {
    const text = '인천내항 8부두 주차장. 인천내항 8부두 주차장. 인천내항 8부두 주차장.'
    expect(aggregateLotNames([text])[0].count).toBe(1)
  })

  it('언급 근처에 무료가 있으면 표시한다', () => {
    const [free] = aggregateLotNames([REAL_INCHEON_PORT])
    expect(free.isFreeHint).toBe(true)

    const [paid] = aggregateLotNames([REAL_SONGWOL])
    expect(paid.isFreeHint).toBe(false)
  })

  it('한 글자만 다른 역 이름을 하나로 합치지 않는다', () => {
    // '동인천역' 을 '인천역' 으로 삼키면 사람을 다른 주차장으로 보낸다
    const result = aggregateLotNames(['동인천역 주차장에 댔다', '인천역 주차장이 더 가깝다'])
    expect(result.map((c) => c.normalized).sort()).toEqual(['동인천역', '인천역'])
  })

  it('띄어쓰기만 다른 표기는 같은 후보로 묶는다', () => {
    const result = aggregateLotNames(['한중문화관공영주차장은 가깝다', REAL_HANJUNG])
    expect(result).toHaveLength(1)
    expect(result[0].count).toBe(2)
    expect(result[0].normalized).toBe('한중문화관')
  })
})

describe('normalizeLotName', () => {
  it('공백·괄호·접미를 걷어낸다', () => {
    expect(normalizeLotName('송월동 동화마을 공영주차장')).toBe('송월동동화마을')
    expect(normalizeLotName('인천내항 8부두 주차장(무료)')).toBe('인천내항8부두')
    expect(normalizeLotName('한중문화관 공영주차장')).toBe('한중문화관')
  })

  it('서수 제는 떼되 숫자는 남긴다 — 제1과 1은 같은 곳, 제1과 제2는 다른 곳', () => {
    // 2026-09-02 변경. 전에는 '제'를 남겨 제1 ≠ 1 로 봤는데, 그러면 후기의
    // "인천 내항 8부두 주차장"이 DB 의 "인천내항제8부두 주차장"(KA-885092762, 무료)과
    // 매칭되지 않는다. 차이나타운 표본에서 가장 많이 언급된 대안이 바로 그곳이다.
    //
    // 안전성은 전체 31,994곳으로 실측했다 — 이 규칙으로 새로 겹치는 이름은 25건뿐이고
    // 그마저 대부분 같은 주차장의 다른 표기다('안동터미널제2주차장' / '안동터미널 2 공영 주차장').
    expect(normalizeLotName('시청 제1주차장')).toBe('시청1')
    expect(normalizeLotName('시청 1주차장')).toBe('시청1')
    expect(normalizeLotName('시청 제1주차장')).toBe(normalizeLotName('시청 1주차장'))

    // 숫자가 다르면 여전히 다른 주차장이다
    expect(normalizeLotName('시청 제1주차장')).not.toBe(normalizeLotName('시청 제2주차장'))

    // 실제 매칭 사례: 후기 표기 ↔ DB 표기
    expect(normalizeLotName('인천 내항 8부두 주차장')).toBe(
      normalizeLotName('인천내항제8부두 주차장'),
    )

    // '제'가 숫자 앞이 아니면 건드리지 않는다 (제물포·제주 같은 지명)
    expect(normalizeLotName('제물포역 공영주차장')).toBe('제물포역')
    expect(normalizeLotName('제주시청 주차장')).toBe('제주시청')
  })

  it('빈 값은 빈 문자열이다', () => {
    expect(normalizeLotName('')).toBe('')
    expect(normalizeLotName('주차장')).toBe('')
  })
})
