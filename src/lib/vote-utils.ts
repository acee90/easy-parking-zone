const ANON_COOKIE = 'parking_anon_id'

/** request에서 익명 ID 쿠키를 읽음 */
export function getAnonIdFromRequest(request: Request): string | null {
  const cookie = request.headers.get('cookie') ?? ''
  const match = cookie.split('; ').find((c) => c.startsWith(`${ANON_COOKIE}=`))
  return match?.split('=')[1] ?? null
}

/** 로그인 유저 → user_id, 비로그인 → cookie anonId */
export function resolveVoterId(userId: string | null, anonId: string | null): string | null {
  if (userId) return userId
  if (anonId?.startsWith('anon_')) return anonId
  return null
}

/** 새 익명 ID 생성 */
export function generateAnonId(): string {
  return `anon_${crypto.randomUUID()}`
}

/** Set-Cookie 값 생성 */
export function buildAnonCookieValue(anonId: string): string {
  return `${ANON_COOKIE}=${anonId};Path=/;Max-Age=${365 * 86400};SameSite=Lax;HttpOnly`
}
