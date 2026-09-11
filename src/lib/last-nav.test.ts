import { beforeEach, describe, expect, it } from 'vitest'
import {
  PROMPT_MAX_AGE_MS,
  PROMPT_MIN_AGE_MS,
  recordNavigation,
  takePendingPrompt,
} from './last-nav'

const T0 = 1_780_000_000_000

describe('last-nav', () => {
  beforeEach(() => localStorage.clear())

  it('기록이 없으면 묻지 않는다', () => {
    expect(takePendingPrompt(T0)).toBeNull()
  })

  it('2시간 전이면 아직 묻지 않고, 기록도 남긴다', () => {
    recordNavigation('KA-1', '경향신문 주차장', T0)
    expect(takePendingPrompt(T0 + PROMPT_MIN_AGE_MS - 1)).toBeNull()
    expect(takePendingPrompt(T0 + PROMPT_MIN_AGE_MS)?.lotId).toBe('KA-1')
  })

  it('한 번 꺼내면 다시 묻지 않는다', () => {
    recordNavigation('KA-1', '경향신문 주차장', T0)
    const at = T0 + PROMPT_MIN_AGE_MS
    expect(takePendingPrompt(at)).toEqual({ lotId: 'KA-1', name: '경향신문 주차장', at: T0 })
    expect(takePendingPrompt(at)).toBeNull()
  })

  it('14일이 지나면 묻지 않고 버린다', () => {
    recordNavigation('KA-1', '경향신문 주차장', T0)
    expect(takePendingPrompt(T0 + PROMPT_MAX_AGE_MS + 1)).toBeNull()
    expect(takePendingPrompt(T0 + PROMPT_MIN_AGE_MS)).toBeNull()
  })

  it('새 길찾기가 이전 기록을 덮는다', () => {
    recordNavigation('KA-1', 'A', T0)
    recordNavigation('KA-2', 'B', T0 + 1000)
    expect(takePendingPrompt(T0 + 1000 + PROMPT_MIN_AGE_MS)?.lotId).toBe('KA-2')
  })

  it('깨진 값은 버린다', () => {
    localStorage.setItem('ep:last-nav', '{not json')
    expect(takePendingPrompt(T0)).toBeNull()
    localStorage.setItem('ep:last-nav', JSON.stringify({ lotId: 1 }))
    expect(takePendingPrompt(T0)).toBeNull()
    expect(localStorage.getItem('ep:last-nav')).toBeNull()
  })
})
