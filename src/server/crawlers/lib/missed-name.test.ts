import { describe, expect, it } from 'vitest'
import { extractMissedLotName, isNoiseLotName } from './missed-name'

describe('extractMissedLotName', () => {
  it('제목에 주차장이 있으면 그 앞 토큰을 장소명으로 쓴다', () => {
    expect(extractMissedLotName('스타필드 하남 주차장 후기', '').join(' ')).toBe('스타필드 하남')
  })

  it('제목에 주차장이 없으면 필러를 걸러내고 가장 긴 명사를 앞에 둔다', () => {
    expect(extractMissedLotName('아이들과 함께 가기 좋은 김제시립도서관 방문기', '')).toEqual([
      '김제시립도서관',
    ])
  })

  it('제목이 비면 본문 앞부분에서 뽑는다', () => {
    expect(extractMissedLotName('', '양구선사박물관 주차 정보')).toEqual(['양구선사박물관'])
  })

  it('뽑을 게 없으면 빈 배열', () => {
    expect(extractMissedLotName('', '')).toEqual([])
  })
})

describe('isNoiseLotName', () => {
  it.each([
    ['지하', '일반명'],
    ['플레이스뷰', '페이지·서비스명'],
    ['강남역', '역명'],
    ['', '빈 이름'],
  ])('%s 는 노이즈 (%s)', (name) => {
    expect(isNoiseLotName(name)).toBe(true)
  })

  it.each([['타임스퀘어 주차장'], ['스타필드 하남']])('%s 는 노이즈가 아니다', (name) => {
    expect(isNoiseLotName(name)).toBe(false)
  })
})
