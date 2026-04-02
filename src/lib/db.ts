import { env } from 'cloudflare:workers'

/** Cloudflare D1 바인딩 접근 */
export function getDB(): D1Database {
  return env.DB
}
