import { describe, expect, it } from 'vitest'
import { hasSiteChrome, stripSiteChrome } from './strip-site-chrome'

// 전부 remote D1 web_sources.ai_summary 실제 값에서 가져온 표본이다.
describe('stripSiteChrome — 실제 오염 표본', () => {
  it('티스토리 메뉴 줄을 걷어낸다', () => {
    const r = stripSiteChrome(
      'father5 (p`>ω<´q) 글쓰기 관리 태그 방명록 RSS father5 CATEGORY 분류 전체보기 (2773) 방명록 티스토리 뷰 스타필드시티위례 CGV 상영시간표와 주차장 이용 꿀팁을 정리했습니다.',
    )
    expect(r.hadChrome).toBe(true)
    expect(r.text).not.toContain('글쓰기')
    expect(r.text).not.toContain('방명록')
    expect(r.text).not.toContain('분류 전체보기')
    expect(r.text).toContain('스타필드시티위례')
  })

  it('워드프레스 건너뛰기·예제 페이지를 걷어낸다', () => {
    const r = stripSiteChrome(
      '콘텐츠로 건너뛰기 선한 예제 페이지 선한 예제 페이지 연제문화체육공원 공영 주차장은 24시간 운영하며 요금은 30분 500원입니다.',
    )
    expect(r.text).not.toContain('건너뛰기')
    expect(r.text).not.toContain('예제 페이지')
    expect(r.text).toContain('연제문화체육공원')
  })

  it('skip to main 류를 걷어낸다', () => {
    const r = stripSiteChrome(
      'skip to main | skip to sidebar 일상의여행 주차꿀팁 인천 월미도와 차이나타운 방문 시 무료 주차장은 상상플랫폼 8부두입니다.',
    )
    expect(r.text).not.toMatch(/skip to/i)
    expect(r.text).toContain('8부두')
  })

  it('About/Contact/Privacy 메뉴를 걷어낸다', () => {
    const r = stripSiteChrome(
      '위니스타일 소개 페이지 (About) 연락처 페이지 (Contact) (Privacy Policy) 광고 게재 방침 (Advertising Policy) 보문산 주차장은 무료로 운영되며 자리가 넉넉한 편입니다. 주말 오전에는 등산객이 몰려 만차가 되기도 하니 이른 시간에 방문하는 편이 좋습니다.',
    )
    expect(r.text).not.toContain('Privacy Policy')
    expect(r.text).toContain('보문산')
  })

  it('광고 슬롯 표기(728x90)를 지운다', () => {
    const r = stripSiteChrome(
      '지식 대장간 블로그 내 검색 검색 관리 글쓰기 로그인 로그아웃 메뉴 홈 태그 방명록 해운대 달맞이고개 해월정 공영주차장의 위치와 요금을 정리합니다. 달맞이고개 정상 부근이라 진입로가 가파르고 좁으니 초보 운전자는 주의가 필요합니다. 728x90',
    )
    expect(r.text).not.toContain('728x90')
    expect(r.text).toContain('해월정')
  })
})

describe('stripSiteChrome — 과잉 제거 방지', () => {
  it('메뉴 낱말이 문장 속에 한 번만 나오면 살린다', () => {
    const t =
      '주차장 입구에서 관리 아저씨가 안내해 주셔서 어렵지 않게 자리를 찾았습니다. 넓고 편했어요.'
    const r = stripSiteChrome(t)
    expect(r.text).toContain('관리 아저씨')
  })

  it('정상 후기는 손대지 않는다', () => {
    const t =
      '차이나타운 갈 때 여기 댔습니다. 걸어서 3분이고 만차면 8부두 무료주차장으로 가면 되는데 거긴 10분 걸어야 해요.'
    const r = stripSiteChrome(t)
    expect(r.text).toBe(t)
    expect(r.hadChrome).toBe(false)
    expect(r.removed).toBe(0)
  })
})

describe('stripSiteChrome — 경계', () => {
  it('메뉴만 있던 글은 null 로 만든다', () => {
    const r = stripSiteChrome('글쓰기 관리 로그인 로그아웃 메뉴 홈 태그 방명록 RSS')
    expect(r.text).toBeNull()
    expect(r.hadChrome).toBe(true)
  })
  it('빈 값', () => {
    expect(stripSiteChrome(null).text).toBeNull()
    expect(stripSiteChrome('').text).toBeNull()
  })
  it('hasSiteChrome 는 판정만 한다', () => {
    expect(hasSiteChrome('콘텐츠로 건너뛰기 주차장 정보입니다.')).toBe(true)
    expect(hasSiteChrome('주차장이 넓고 편했습니다.')).toBe(false)
  })
})

describe('stripSiteChrome — 2026-09-02 감사 회귀', () => {
  it('지운 게 없으면 짧아도 버리지 않는다', () => {
    // 운영 272건이 이렇게 사라지고 있었다. null 이 되면 `summary ?? snippet` 폴백이 걸려
    // 그 자리에 원문 스크랩(예: 렌터카 시승 후기)이 대신 뜬다 — 고치려던 문제를 되레 키운다.
    const r = stripSiteChrome('초보자도 쉬운 넓은 주차장')
    expect(r.text).toBe('초보자도 쉬운 넓은 주차장')
    expect(r.hadChrome).toBe(false)
    expect(r.removed).toBe(0)

    expect(stripSiteChrome('현대백화점 어플 활용 압구정점 2시간 무료 주차').text).toBe(
      '현대백화점 어플 활용 압구정점 2시간 무료 주차',
    )
    expect(stripSiteChrome('주변 타워형 많고 비용 높음').text).toBe('주변 타워형 많고 비용 높음')
  })

  it('메뉴만 있던 글은 여전히 버린다', () => {
    expect(stripSiteChrome('글쓰기 관리 로그인 로그아웃 메뉴 홈 태그 방명록 RSS').text).toBeNull()
  })

  it('낱말 경계 — 앞 낱말의 꼬리를 먹지 않는다', () => {
    // 실데이터: "부산신부관리 검색" 이 "부산신부" 로 잘렸다
    const r = stripSiteChrome(
      '반려동물 동반 가능 부산신부관리 검색 중 범천동 근처에 위치한 서면에스테틱을 다녀왔습니다.',
    )
    expect(r.text).toContain('부산신부관리')
  })

  it('낱말 경계 — 뒤 낱말의 머리를 먹지 않는다', () => {
    // "이전 다음 홈페이지에서…" 가 "페이지에서…" 로 잘렸다
    const r = stripSiteChrome(
      '이전 다음 홈페이지에서 사전 예약하면 30분 무료 주차권을 받을 수 있어 훨씬 저렴합니다.',
    )
    expect(r.text).toContain('홈페이지에서')
    expect(r.text).toContain('30분 무료 주차권')
  })

  it('공백만 정리된 경우는 메뉴가 있었다고 보지 않는다', () => {
    // hasSiteChrome 은 배치 대상 선별에 쓴다. 공백으로 참이 되면 1,110건이 헛돈다.
    const r = stripSiteChrome('주차장이   넓고    편했습니다. 자리도 넉넉해서 좋았어요.')
    expect(r.hadChrome).toBe(false)
    expect(hasSiteChrome('주차장이   넓고    편했습니다. 자리도 넉넉해서 좋았어요.')).toBe(false)
  })
})
