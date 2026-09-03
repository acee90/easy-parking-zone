import { describe, expect, it } from 'vitest'
import { isCronTriggerAuthorized } from './worker-entry'

const TOKEN = 'a'.repeat(48)

function check(opts: { header?: string; query?: string; token?: string }) {
  const url = new URL(
    `https://easy-parking.xyz/__scheduled${opts.query ? `?token=${opts.query}` : ''}`,
  )
  const request = new Request(url, {
    headers: opts.header ? { 'X-Cron-Token': opts.header } : {},
  })
  return isCronTriggerAuthorized(request, url, { CRON_TRIGGER_TOKEN: opts.token })
}

describe('isCronTriggerAuthorized', () => {
  it('토큰이 설정돼 있지 않으면 막는다 — 시크릿 누락이 무방비가 되면 안 된다', () => {
    expect(check({ header: TOKEN, token: undefined })).toBe(false)
    expect(check({ header: '', token: '' })).toBe(false)
  })

  it('토큰이 없으면 막는다 (예전에는 경로만 맞으면 통과였다)', () => {
    expect(check({ token: TOKEN })).toBe(false)
  })

  it('헤더로 맞으면 통과', () => {
    expect(check({ header: TOKEN, token: TOKEN })).toBe(true)
  })

  it('쿼리로도 통과 — 헤더를 못 붙이는 곳을 위해', () => {
    expect(check({ query: TOKEN, token: TOKEN })).toBe(true)
  })

  it('틀린 토큰은 막는다', () => {
    expect(check({ header: 'b'.repeat(48), token: TOKEN })).toBe(false)
  })

  it('앞부분만 맞는 토큰도 막는다', () => {
    expect(check({ header: `${'a'.repeat(47)}b`, token: TOKEN })).toBe(false)
  })

  it('길이가 다르면 막는다', () => {
    expect(check({ header: 'a'.repeat(47), token: TOKEN })).toBe(false)
    expect(check({ header: 'a'.repeat(49), token: TOKEN })).toBe(false)
  })
})
