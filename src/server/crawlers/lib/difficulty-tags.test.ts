import { describe, expect, it } from 'vitest'
import { normalizeDifficultyKeywords, parseKeywordJson } from './difficulty-tags'

describe('normalizeDifficultyKeywords', () => {
  it('흩어진 원형을 하나의 태그로 모은다', () => {
    // remote 실측: 좁(182) 좁다(113) 좁음(36) 좁은(32) 협소(55) 가 따로 세어지고 있었다
    const r = normalizeDifficultyKeywords([['좁'], ['좁다'], ['좁음'], ['좁은'], ['협소']])
    expect(r).toHaveLength(1)
    expect(r[0].label).toBe('협소')
    expect(r[0].count).toBe(5)
    expect(r[0].polarity).toBe('bad')
  })

  it('넓 계열도 하나로 모은다', () => {
    const r = normalizeDifficultyKeywords([['넓'], ['넓음'], ['넓다'], ['넓은']])
    expect(r).toHaveLength(1)
    expect(r[0].label).toBe('넓음')
    expect(r[0].polarity).toBe('good')
  })

  it('혼잡·만차는 묶되 복잡은 따로 둔다', () => {
    // 2026-09-02 감사 반영. 복잡(168 lot)은 "자리가 없다"와 "구조가 복잡하다"를 둘 다 뜻할 수 있어
    // 혼잡으로 합치면 근거 없이 혼잡도를 부풀린다.
    const r = normalizeDifficultyKeywords([['혼잡'], ['만차'], ['복잡']])
    const byLabel = Object.fromEntries(r.map((t) => [t.label, t.count]))
    expect(byLabel['혼잡']).toBe(2)
    expect(byLabel['복잡함']).toBe(1)
  })

  it('원인을 특정할 수 없는 말은 단정하지 않는다', () => {
    // 전에는 불편(413 lot)·어렵(130 lot)을 '진입 어려움'으로 매핑했다.
    // 불편의 원인은 요금일 수도 통로일 수도 있어 진입이라고 단정할 근거가 없었다.
    const r = normalizeDifficultyKeywords([['불편'], ['어렵'], ['어려움']])
    const labels = r.map((t) => t.label)
    expect(labels).toContain('불편하다는 평')
    expect(labels).toContain('어렵다는 평')
    expect(labels).not.toContain('진입 어려움')
  })

  it('뜻이 갈리는 조각은 아예 버린다', () => {
    // 폭(폭포) · 급(급속충전) · 제한(시간제한) · 층(지상 N층) · 편(편의점) · 부담(요금 부담)
    expect(
      normalizeDifficultyKeywords([['폭'], ['급'], ['제한'], ['층'], ['편'], ['부담']]),
    ).toEqual([])
  })

  it('빈도순으로 정렬한다', () => {
    const r = normalizeDifficultyKeywords([['혼잡'], ['혼잡'], ['혼잡'], ['넓'], ['좁']])
    expect(r[0].label).toBe('혼잡')
    expect(r[0].count).toBe(3)
  })

  it('한 글에서 같은 태그가 겹쳐도 1회로 센다', () => {
    const r = normalizeDifficultyKeywords([['좁', '협소', '좁다']])
    expect(r).toHaveLength(1)
    expect(r[0].count).toBe(1)
  })

  it('사전에 없는 말은 버린다', () => {
    const r = normalizeDifficultyKeywords([['알수없는말'], ['혼잡']])
    expect(r).toHaveLength(1)
    expect(r[0].label).toBe('혼잡')
  })

  it('차이나타운 실제 값 — 상반된 협소·넓음은 동수라 둘 다 빠진다', () => {
    // remote 실측: ["진입"], ["주의"], ["넓다"], ["혼잡"], ["좁","혼잡"]
    // 협소 1 · 넓음 1 은 서로 상쇄된다. 나란히 띄우면 읽는 사람에게 아무 정보도 못 준다.
    const r = normalizeDifficultyKeywords([['진입'], ['주의'], ['넓다'], ['혼잡'], ['좁', '혼잡']])
    const byLabel = Object.fromEntries(r.map((t) => [t.label, t.count]))
    expect(byLabel['혼잡']).toBe(2)
    expect(byLabel['진입 어려움']).toBe(1)
    expect(byLabel['주의 필요']).toBe(1)
    expect(byLabel['협소']).toBeUndefined()
    expect(byLabel['넓음']).toBeUndefined()
  })

  it('상반된 태그 — 더 많이 언급된 쪽만 남긴다', () => {
    // 실측 94곳에서 '협소'와 '넓음'이 나란히 떴다
    const r = normalizeDifficultyKeywords([['좁'], ['좁다'], ['협소'], ['넓']])
    const byLabel = Object.fromEntries(r.map((t) => [t.label, t.count]))
    expect(byLabel['협소']).toBe(3)
    expect(byLabel['넓음']).toBeUndefined()
  })

  it('이미 있는 태그의 명백한 변형도 받아준다', () => {
    // 전에는 사전 미등재로 20.4%가 버려졌고, 키워드 보유 lot 의 9.8%는 태그가 0개가 됐다
    const r = normalizeDifficultyKeywords([
      ['진입로'],
      ['진입어려움'],
      ['높이제한'],
      ['기계'],
      ['가파'],
    ])
    const labels = r.map((t) => t.label)
    expect(labels).toContain('진입 어려움')
    expect(labels).toContain('높이 제한')
    expect(labels).toContain('기계식')
    expect(labels).toContain('경사')
  })

  it('빈 입력', () => {
    expect(normalizeDifficultyKeywords([])).toEqual([])
    expect(normalizeDifficultyKeywords([null, undefined, []])).toEqual([])
  })
})

describe('parseKeywordJson', () => {
  it('JSON 배열을 읽는다', () => {
    expect(parseKeywordJson('["좁","혼잡"]')).toEqual(['좁', '혼잡'])
  })
  it('빈 값·깨진 값은 null', () => {
    expect(parseKeywordJson('[]')).toBeNull()
    expect(parseKeywordJson(null)).toBeNull()
    expect(parseKeywordJson('깨진값')).toBeNull()
  })
})
