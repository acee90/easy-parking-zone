export function getClientIP(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

/**
 * IP 기준 rate limit 체크. request가 없으면(SSR 내부 직접 호출 등) 통과시킨다.
 * 초과 시 Error throw — 다른 server fn과 동일하게 클라이언트에 일반 에러로 전달된다.
 */
export async function checkRateLimit(
  limiter: RateLimit,
  request: Request | undefined,
  message = '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.',
): Promise<void> {
  if (!request) return
  const ip = getClientIP(request)
  if (ip === 'unknown') return
  const { success } = await limiter.limit({ key: ip })
  if (!success) throw new Error(message)
}
