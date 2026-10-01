import { describe, expect, it } from 'vitest'
import { estimateVerifiedFee, getVerifiedParkingGuide } from './verified-parking-guides'

describe('공식 요금 조건의 경계', () => {
  const ifc = getVerifiedParkingGuide('KA-2056009871')
  const suwon = getVerifiedParkingGuide('KA-644595051')
  const pangyo = getVerifiedParkingGuide('KA-27593534')
  if (!ifc || !suwon || !pangyo) throw new Error('검증 대상 주차장 누락')
  it('IFC 회차시간을 넘기면 최초 30분 요금도 부과한다', () => {
    expect(estimateVerifiedFee(ifc, 30)).toBe(0)
    expect(estimateVerifiedFee(ifc, 31)).toBe(4000)
    expect(estimateVerifiedFee(ifc, 60)).toBe(6000)
    expect(estimateVerifiedFee(ifc, 480)).toBe(45000)
  })
  it('수원은 무료 6시간을 공제하고 추가 단위를 올림한다', () => {
    expect(estimateVerifiedFee(suwon, 360)).toBe(0)
    expect(estimateVerifiedFee(suwon, 361)).toBe(500)
    expect(estimateVerifiedFee(suwon, 420)).toBe(3000)
    expect(estimateVerifiedFee(suwon, 800)).toBe(18000)
  })
  it('판교의 최초 30분 무료는 IFC의 조건부 회차와 다르다', () => {
    expect(estimateVerifiedFee(pangyo, 30)).toBe(0)
    expect(estimateVerifiedFee(pangyo, 31)).toBe(1000)
    expect(estimateVerifiedFee(pangyo, 60)).toBe(3000)
  })
  it('잘못된 시간으로 금액을 만들지 않는다', () => {
    for (const minutes of [0, -1, NaN, Infinity])
      expect(estimateVerifiedFee(ifc, minutes)).toBeNull()
  })
})
