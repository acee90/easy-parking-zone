import { describe, expect, it } from 'vitest'
import { parseAiJson } from './ai-client'

describe('parseAiJson', () => {
  it('평범한 JSON 을 판다', () => {
    expect(parseAiJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  it('```json 펜스를 벗긴다 — 서버가 json 모드를 강제하지 않아 실제로 이렇게 온다', () => {
    expect(parseAiJson('```json\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('<think> 추론 블록을 걷어낸다', () => {
    expect(parseAiJson('<think>고민중</think>{"a":1}')).toEqual({ a: 1 })
  })

  it('펜스 앞 잡담을 걷어낸다', () => {
    expect(parseAiJson('알겠습니다.\n```\n{"a":1}\n```')).toEqual({ a: 1 })
  })

  it('토큰이 잘려 빈 문자열이 오면 null — 조용한 실패를 값으로 만들지 않는다', () => {
    expect(parseAiJson('')).toBeNull()
  })

  it('깨진 JSON 은 throw 하지 않고 null', () => {
    expect(parseAiJson('{"a":')).toBeNull()
  })
})
