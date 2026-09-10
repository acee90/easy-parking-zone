import { describe, expect, it } from 'vitest'
import { resolveTransition, statusToFieldSource } from './lot-field-transitions'

describe('resolveTransition (A안)', () => {
  it('빈 칸은 즉시 반영된다', () => {
    expect(resolveTransition({ activeStatus: null, baseIsEmpty: true })).toEqual({
      nextStatus: 'applied',
      supersedeActive: false,
      baseHadValue: false,
    })
  })

  // A안의 핵심. 공공데이터·운영사 값은 sync 가 다시 덮으므로 즉시 반영을 허용하지 않는다
  it('원본에 값이 있으면 승인 큐로 간다', () => {
    expect(resolveTransition({ activeStatus: null, baseIsEmpty: false })).toEqual({
      nextStatus: 'pending',
      supersedeActive: false,
      baseHadValue: true,
    })
  })

  it('유저가 채운 칸은 다른 유저가 바로 덮어쓸 수 있다', () => {
    expect(resolveTransition({ activeStatus: 'applied', baseIsEmpty: false })).toEqual({
      nextStatus: 'applied',
      supersedeActive: true,
      baseHadValue: true,
    })
  })

  it('관리자가 확인한 칸은 잠긴다 — 요청은 되지만 바로 반영되지 않는다', () => {
    expect(resolveTransition({ activeStatus: 'verified', baseIsEmpty: true })).toEqual({
      nextStatus: 'pending',
      supersedeActive: false,
      baseHadValue: true,
    })
  })

  // verified 는 원본이 비어 있어도 잠긴 상태다 — baseIsEmpty 에 흔들리면 안 된다
  it('verified 판정은 원본이 비었는지와 무관하다', () => {
    const a = resolveTransition({ activeStatus: 'verified', baseIsEmpty: true })
    const b = resolveTransition({ activeStatus: 'verified', baseIsEmpty: false })
    expect(a).toEqual(b)
  })
})

describe('statusToFieldSource', () => {
  it('applied 는 유저 값, verified 는 확인된 값', () => {
    expect(statusToFieldSource('applied')).toBe('user')
    expect(statusToFieldSource('verified')).toBe('verified')
  })
})
