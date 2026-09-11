import { describe, expect, it } from 'vitest'
import { curateLots, lotNameIssue } from './lot-name-quality'

// 픽스처 대부분은 09-11 블라인드 채점(1차)의 판정이다 — 규칙을 고칠 때 되돌아가지 않는지 본다
describe('lotNameIssue — 뺀다', () => {
  it.each([
    ['주차장', 'generic'],
    ['공영주차장', 'generic'],
    ['공영 주차장', 'generic'],
    ['사설주차장', 'generic'],
    ['광장 주차장', 'generic'],
    ['국립공원주차장', 'generic'],
    ['제2주차장', 'generic'],
    ['을지로', 'generic'],
    ['인천공항 주차대행', 'service'],
    ['제주화물자동차 공영차고지', 'service'],
    ['시화공단 내 도로', 'road'],
    ['남목9길 이면도로', 'road'],
    ['낙산 7호넷비치 ~ 롤리카페 도로변', 'road'],
    ['가제교~신안동 320 하상주차장', 'segment'],
    ['3공단로인근', 'segment'],
    ['송림사 외', 'segment'],
    ['홍도동 경성3차@~청룡@ 주변', 'segment'],
    ['교원내외빌딩주차장출구', 'gate'],
    ['국민연금공단의정부지사주차장입구', 'gate'],
    ['대경아파트 입구(우측)', 'gate'],
    ['기지제수변공원 주차장 (공사중)', 'closed'],
    ['미추홀구 주차장', 'region-only'],
    ['칠곡군공영주차장', 'region-only'],
    ['완도군 공용주차장', 'region-only'],
    ['대전 서구 공영주차장', 'region-only'],
    ['서귀포시 주차장', 'region-only'],
    ['신정1동', 'admin-only'],
    ['연암동 442-1', 'admin-only'],
    ['성산면1', 'admin-only'],
    ['상리2길', 'admin-only'],
    ['봉산길', 'generic'],
  ])('%s → %s', (name, reason) => {
    expect(lotNameIssue(name)).toBe(reason)
  })
})

describe('lotNameIssue — 시·군·구명은 자기 주소와 대조한다', () => {
  it('자기 주소의 시·군·구면 뺀다', () => {
    expect(lotNameIssue('수정구 주차장', '경기 성남시 수정구 대왕판교로 825')).toBe('region-only')
    expect(lotNameIssue('칠곡군공영주차장', '경북 칠곡군 왜관읍 중앙로 1')).toBe('region-only')
  })

  it('「○구」로 끝나는 고유명은 주소에 없으면 남긴다', () => {
    expect(lotNameIssue('청구 주차장', '대구광역시 수성구 만촌동 667-11')).toBeNull()
  })
})

describe('lotNameIssue — 남긴다', () => {
  it.each([
    // 1차 채점에서 적합 판정인데 옛 규칙(2글자+주차장)이 막던 것
    '명품주차장',
    '방축주차장',
    '내향 주차장',
    '필주차장',
    '새빌 주차장',
    '알리주차장',
    '순창주차장',
    '대각주차장',
    '선동주차장',
    '옥천주차장',
    // 부분 문자열·끝말 규칙 오탐 방지
    '어반포트 홍대입구역 에이치큐브 주차장',
    '삼악산 상원사입구주차장',
    '용봉초교 앞 주차장(용봉산 입구)',
    '백수해안도로 제1주차장',
    '주전직선화도로 공영 주차장',
    '동탄역 임시공영유료주차장',
    '역곡역1번출구 주차장',
    '영실입구 주차장',
    '유성구청 주차장',
    '강남구청 주차장',
    '동대구역 주차장',
    '서울시청 공영 주차장',
    '주차장 롯데백화점 광복점',
    '스타필드시티 부천 주차장',
    '송도센트럴공원',
  ])('%s', (name) => {
    expect(lotNameIssue(name)).toBeNull()
  })
})

describe('curateLots', () => {
  it('걸러낸 뒤 순서를 유지하고, 다른 도시의 동명 lot 은 둘 다 남긴다', () => {
    const lots = [
      { name: '주차장', address: '부산 해운대구 중동 1480-4' },
      { name: '타임스퀘어 주차장', address: '서울 영등포구 영중로 15' },
      { name: '한옥마을 주차장', address: '전북 전주시 백제대로 310' },
      { name: '한옥마을 주차장', address: '경북 경주시 사정로 27' },
    ]
    expect(curateLots(lots, 9).map((l) => l.address)).toEqual([
      '서울 영등포구 영중로 15',
      '전북 전주시 백제대로 310',
      '경북 경주시 사정로 27',
    ])
  })

  it('시·도 표기가 달라도(충청북도/충북) 같은 이름은 하나만', () => {
    const lots = [
      { name: '금왕읍 공영주차장', address: '충청북도 음성군 금왕읍 무극리 594-1' },
      { name: '금왕읍공영주차장', address: '충북 음성군 금왕읍 무극리 594-1' },
    ]
    expect(curateLots(lots, 9)).toHaveLength(1)
  })

  it('이름이 달라도 주소 끝이 같으면 하나만', () => {
    const lots = [
      { name: '구미역 후면광장 지하주차장', address: '경북 구미시 구미중앙로 76' },
      { name: '구미역 타워 주차장', address: '경북 구미시 구미중앙로 76' },
    ]
    expect(curateLots(lots, 9).map((l) => l.name)).toEqual(['구미역 후면광장 지하주차장'])
  })

  it('접미사(공영·번호)만 다른 이름은 주소가 달라도 하나만 — 목록에서 구분이 안 된다', () => {
    const lots = [
      { name: '함허동천 공영주차장', address: '인천 강화군 화도면 사기리 290-8' },
      { name: '함허동천 1주차장', address: '인천 강화군 화도면 사기리 403-1' },
    ]
    expect(curateLots(lots, 9)).toHaveLength(1)
  })

  it('이름·주소가 모두 다르면 둘 다 남긴다', () => {
    const lots = [
      { name: '종합운동장 주차장', address: '강원특별자치도 강릉시 교동 2-10' },
      { name: '강릉종합운동장 주차장', address: '강원특별자치도 강릉시 종합운동장길 69' },
    ]
    expect(curateLots(lots, 9)).toHaveLength(2)
  })

  it('n 개에서 멈춘다', () => {
    const lots = Array.from({ length: 20 }, (_, i) => ({
      name: `테스트 주차장 ${i}`,
      address: `서울 중구 세종대로 ${i}`,
    }))
    expect(curateLots(lots, 9)).toHaveLength(9)
  })
})
