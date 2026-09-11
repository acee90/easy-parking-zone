import { describe, expect, it } from 'vitest'
import { curateLots, lotNameIssue } from './lot-name-quality'

describe('lotNameIssue', () => {
  it.each([
    ['주차장', 'generic'],
    ['인천공항 주차대행', 'service'],
    ['시화공단 내 도로', 'road'],
    ['남목9길 이면도로', 'road'],
    ['교원내외빌딩주차장출구', 'gate'],
    ['국민연금공단의정부지사주차장입구', 'gate'],
    ['대경아파트 입구(우측)', 'gate'],
    ['기지제수변공원 주차장 (공사중)', 'closed'],
    ['미추홀구 주차장', 'region-only'],
  ])('%s → %s', (name, reason) => {
    expect(lotNameIssue(name)).toBe(reason)
  })

  it.each([
    '어반포트 홍대입구역 에이치큐브 주차장',
    '삼악산 상원사입구주차장',
    '용봉초교 앞 주차장(용봉산 입구)',
    '백수해안도로 제1주차장',
    '주전직선화도로 공영 주차장',
    '동탄역 임시공영유료주차장',
    '서울시청 공영 주차장',
    '주차장 롯데백화점 광복점',
    '스타필드시티 부천 주차장',
    '송도센트럴공원',
    '역곡역1번출구 주차장',
    '영실입구 주차장',
  ])('%s 는 통과', (name) => {
    expect(lotNameIssue(name)).toBeNull()
  })
})

describe('curateLots', () => {
  it('걸러낸 뒤 순서를 유지하고 같은 시·도 동명은 하나만', () => {
    const lots = [
      { name: '주차장', address: '부산 해운대구' },
      { name: '타임스퀘어 주차장', address: '서울 영등포구' },
      { name: '타임스퀘어  주차장', address: '서울특별시 영등포구' },
      { name: '한옥마을 주차장', address: '전북 전주시' },
      { name: '한옥마을 주차장', address: '경북 경주시' },
    ]
    expect(curateLots(lots, 9).map((l) => `${l.name}@${l.address}`)).toEqual([
      '타임스퀘어 주차장@서울 영등포구',
      '한옥마을 주차장@전북 전주시',
      '한옥마을 주차장@경북 경주시',
    ])
  })

  it('n 개에서 멈춘다', () => {
    const lots = Array.from({ length: 20 }, (_, i) => ({ name: `테스트 주차장 ${i}` }))
    expect(curateLots(lots, 9)).toHaveLength(9)
  })
})
