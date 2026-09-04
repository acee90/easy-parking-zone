import { describe, expect, it, vi } from 'vitest'
import { checkRateLimit, getClientIP } from './rate-limit'

function makeLimiter(success: boolean) {
  const limit = vi.fn().mockResolvedValue({ success })
  return { limiter: { limit } as unknown as RateLimit, limit }
}

describe('getClientIP', () => {
  it('cf-connecting-ip를 우선 사용한다', () => {
    const request = new Request('https://example.com', {
      headers: { 'cf-connecting-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' },
    })
    expect(getClientIP(request)).toBe('1.2.3.4')
  })

  it('cf-connecting-ip 없으면 x-forwarded-for 첫 값을 사용한다', () => {
    const request = new Request('https://example.com', {
      headers: { 'x-forwarded-for': '5.6.7.8, 9.9.9.9' },
    })
    expect(getClientIP(request)).toBe('5.6.7.8')
  })

  it('둘 다 없으면 unknown', () => {
    const request = new Request('https://example.com')
    expect(getClientIP(request)).toBe('unknown')
  })
})

describe('checkRateLimit', () => {
  it('request가 없으면 limiter를 호출하지 않고 통과시킨다', async () => {
    const { limiter, limit } = makeLimiter(false)
    await expect(checkRateLimit(limiter, undefined)).resolves.toBeUndefined()
    expect(limit).not.toHaveBeenCalled()
  })

  it('IP를 알 수 없으면 limiter를 호출하지 않고 통과시킨다', async () => {
    const { limiter, limit } = makeLimiter(false)
    const request = new Request('https://example.com')
    await expect(checkRateLimit(limiter, request)).resolves.toBeUndefined()
    expect(limit).not.toHaveBeenCalled()
  })

  it('limiter가 success:true면 통과시킨다', async () => {
    const { limiter } = makeLimiter(true)
    const request = new Request('https://example.com', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    })
    await expect(checkRateLimit(limiter, request)).resolves.toBeUndefined()
  })

  it('limiter가 success:false면 에러를 던진다', async () => {
    const { limiter } = makeLimiter(false)
    const request = new Request('https://example.com', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    })
    await expect(checkRateLimit(limiter, request)).rejects.toThrow(
      '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
    )
  })

  it('IP를 key로 limiter.limit을 호출한다', async () => {
    const { limiter, limit } = makeLimiter(true)
    const request = new Request('https://example.com', {
      headers: { 'cf-connecting-ip': '1.2.3.4' },
    })
    await checkRateLimit(limiter, request)
    expect(limit).toHaveBeenCalledWith({ key: '1.2.3.4' })
  })
})
