import { describe, expect, it } from 'vitest'
import {
  makeDestinationSlug,
  makeParkingSlug,
  parseDestinationIdFromSlug,
  parseIdFromSlug,
} from './slug'

describe('parseIdFromSlug', () => {
  it('공공데이터 관리번호를 꺼낸다', () => {
    expect(parseIdFromSlug('서울역-공영주차장-118-2-000081')).toBe('118-2-000081')
  })
  it('카카오·네이버 id 를 꺼낸다', () => {
    expect(parseIdFromSlug('석촌역노상공영주차장-KA-365568988')).toBe('KA-365568988')
    expect(parseIdFromSlug('석촌역-2구역-공영주차장-NV-1271061502_375049322')).toBe(
      'NV-1271061502_375049322',
    )
  })
  it('모두의주차장·하이파킹 id 를 꺼낸다', () => {
    expect(parseIdFromSlug('파크-민영-주차장-MODU-260445')).toBe('MODU-260445')
    expect(parseIdFromSlug('하이파킹-주차장-HP-1000')).toBe('HP-1000')
  })
  it('모든 소스 접두사가 slug 왕복을 견딘다', () => {
    const ids = ['118-2-000081', 'KA-365568988', 'NV-1271061502_375049322', 'MODU-260445', 'HP-1']
    for (const id of ids) {
      expect(parseIdFromSlug(makeParkingSlug('테스트 주차장', id))).toBe(id)
    }
  })
  it('목적지 slug 는 주차장 id 로 읽지 않는다', () => {
    expect(parseIdFromSlug('석촌역-D-0001')).toBeNull()
  })
})

describe('destination slug', () => {
  it('이름-id 로 만들고 id 를 다시 꺼낸다', () => {
    const slug = makeDestinationSlug('석촌역', 'D-0001')
    expect(slug).toBe('석촌역-D-0001')
    expect(parseDestinationIdFromSlug(slug)).toBe('D-0001')
  })
  it('공백과 예약 문자를 정리한다', () => {
    expect(makeDestinationSlug('신세계백화점 강남점 / 본관', 'D-0042')).toBe(
      '신세계백화점-강남점--본관-D-0042',
    )
  })
  it('주차장 slug 에서는 목적지 id 가 나오지 않는다', () => {
    expect(
      parseDestinationIdFromSlug(makeParkingSlug('석촌역노상공영주차장', 'KA-365568988')),
    ).toBeNull()
  })
})
