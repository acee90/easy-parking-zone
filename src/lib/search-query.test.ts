import { describe, expect, it } from 'vitest'
import {
  coreQueryString,
  dedupePlacesAgainstLots,
  type KakaoPlaceDocument,
  mergePlaces,
  normalizeSearchQuery,
  parseKakaoPlaces,
} from '@/lib/search-query'
import type { ParkingLot, Place } from '@/types/parking'

/** #164 회귀 방지 — 이 검색어들은 모두 검색 가능한 핵심 키워드를 남겨야 한다 */
const MUST_MATCH_QUERIES = ['석촌역', '석촌역 근처 주차장', '석촌역 주차', '스타필드 위례 주차']

describe('normalizeSearchQuery', () => {
  it.each(MUST_MATCH_QUERIES)('"%s" → 핵심 키워드가 남는다', (query) => {
    const { core } = normalizeSearchQuery(query)
    expect(core.length).toBeGreaterThan(0)
    expect(core).not.toContain('근처')
    expect(core).not.toContain('주차')
    expect(core).not.toContain('주차장')
  })

  it('"석촌역 근처 주차장" → ["석촌역"]', () => {
    expect(normalizeSearchQuery('석촌역 근처 주차장').core).toEqual(['석촌역'])
  })

  it('"스타필드 위례 주차" → ["스타필드", "위례"]', () => {
    expect(normalizeSearchQuery('스타필드 위례 주차').core).toEqual(['스타필드', '위례'])
  })

  it.each([
    '주변',
    '인근',
    '가까운',
    '무료주차',
    '무료주차장',
    '공영주차장',
  ])('탐색 표현 "%s"를 걷어낸다', (word) => {
    expect(normalizeSearchQuery(`석촌역 ${word}`).core).toEqual(['석촌역'])
  })

  it('붙여 쓴 "석촌역주차장"도 핵심만 남긴다', () => {
    expect(normalizeSearchQuery('석촌역주차장').core).toEqual(['석촌역'])
    expect(normalizeSearchQuery('스타필드위례주차').core).toEqual(['스타필드위례'])
  })

  it('수식어만 남는 접미사 분리는 하지 않는다', () => {
    // "무료주차장" → "무료"가 되면 엉뚱한 결과가 잡히므로 원본을 유지한다
    expect(normalizeSearchQuery('무료주차장').core).toEqual(['무료주차장'])
    expect(normalizeSearchQuery('공영주차장').core).toEqual(['공영주차장'])
  })

  it('검색어가 전부 탐색 표현이면 원본 그대로 검색한다', () => {
    const result = normalizeSearchQuery('주차장')
    expect(result.core).toEqual(['주차장'])
    expect(result.changed).toBe(false)
  })

  it('기존 주차장명 검색은 그대로 유지된다', () => {
    expect(normalizeSearchQuery('석촌역 2구역 공영주차장').core).toEqual(['석촌역', '2구역'])
    expect(normalizeSearchQuery('남산 공원').core).toEqual(['남산', '공원'])
    expect(normalizeSearchQuery('  강남역  ').core).toEqual(['강남역'])
  })

  it('빈 문자열은 빈 배열', () => {
    expect(normalizeSearchQuery('').core).toEqual([])
    expect(normalizeSearchQuery('   ').core).toEqual([])
  })

  it('불변식: core의 각 단어는 original의 어떤 단어의 부분 문자열이다', () => {
    const samples = [
      ...MUST_MATCH_QUERIES,
      '석촌역주차장',
      '무료주차장',
      '석촌역 2구역 공영주차장',
      '잠실 롯데월드 주변 무료주차',
    ]
    for (const q of samples) {
      const { original, core } = normalizeSearchQuery(q)
      for (const word of core) {
        expect(original.some((o) => o.includes(word))).toBe(true)
      }
    }
  })
})

describe('coreQueryString', () => {
  it.each([
    ['석촌역', '석촌역'],
    ['석촌역 근처 주차장', '석촌역'],
    ['석촌역 주차', '석촌역'],
    ['스타필드 위례 주차', '스타필드 위례'],
  ])('"%s" → "%s"', (input, expected) => {
    expect(coreQueryString(input)).toBe(expected)
  })
})

function doc(overrides: Partial<KakaoPlaceDocument>): KakaoPlaceDocument {
  return {
    place_name: '석촌역 8호선',
    address_name: '서울 송파구 석촌동',
    x: '127.1',
    y: '37.5',
    category_group_name: '지하철역',
    ...overrides,
  }
}

describe('parseKakaoPlaces', () => {
  it('주차장 카테고리를 제외하지 않는다', () => {
    const places = parseKakaoPlaces([
      doc({ place_name: '석촌역노상공영주차장', category_group_name: '주차장' }),
    ])
    expect(places).toHaveLength(1)
    expect(places[0].category).toBe('주차장')
  })

  it('목적지(비-주차장)를 앞에 놓는다', () => {
    const places = parseKakaoPlaces([
      doc({ place_name: '석촌역 공영주차장', category_group_name: '주차장' }),
      doc({ place_name: '석촌역 8호선', category_group_name: '지하철역' }),
    ])
    expect(places.map((p) => p.name)).toEqual(['석촌역 8호선', '석촌역 공영주차장'])
  })

  it('좌표를 숫자로 변환하고 빈 카테고리는 undefined', () => {
    const [place] = parseKakaoPlaces([doc({ x: '127.106', y: '37.505', category_group_name: '' })])
    expect(place.lat).toBeCloseTo(37.505)
    expect(place.lng).toBeCloseTo(127.106)
    expect(place.category).toBeUndefined()
  })
})

describe('mergePlaces', () => {
  const place = (name: string, address = '서울 송파구'): Place => ({
    name,
    address,
    lat: 37.5,
    lng: 127.1,
  })

  it('이름+주소가 같으면 앞선 그룹을 남긴다', () => {
    const merged = mergePlaces([place('석촌역 8호선')], [place('석촌역  8호선'), place('올리브영')])
    expect(merged.map((p) => p.name)).toEqual(['석촌역 8호선', '올리브영'])
  })

  it('이름이 같아도 주소가 다르면 둘 다 남긴다', () => {
    const merged = mergePlaces([place('스타벅스', '송파구')], [place('스타벅스', '강남구')])
    expect(merged).toHaveLength(2)
  })
})

describe('dedupePlacesAgainstLots', () => {
  const lot = (name: string) => ({ id: 'PK-1', name }) as ParkingLot

  it('우리 DB에 이미 있는 주차장은 장소 목록에서 뺀다', () => {
    const places: Place[] = [
      { name: '석촌역 8호선', address: 'a', lat: 1, lng: 2 },
      { name: '석촌역노상공영주차장', address: 'b', lat: 1, lng: 2 },
    ]
    const result = dedupePlacesAgainstLots(places, [lot('석촌역노상 공영주차장')])
    expect(result.map((p) => p.name)).toEqual(['석촌역 8호선'])
  })

  it('주차장 결과가 없으면 그대로 반환', () => {
    const places: Place[] = [{ name: '석촌역 8호선', address: 'a', lat: 1, lng: 2 }]
    expect(dedupePlacesAgainstLots(places, [])).toEqual(places)
  })
})
