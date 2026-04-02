import { env } from 'cloudflare:workers'
import { drizzle } from 'drizzle-orm/d1'
import { createD1Binding } from './d1-proxy'
import * as schema from './schema'

const CF_ACCOUNT_ID = '434357ee2e3363aea69437f67e2053ef'
const CF_DATABASE_ID = 'ff5d77af-8ca6-4e5c-acf2-2fdf765dd248'

export function getDb() {
  // D1_PROXY_TOKEN이 설정되면 remote D1 REST API 사용 (로컬 dev용)
  const proxyToken = (env as Record<string, unknown>).D1_PROXY_TOKEN as string | undefined
  if (proxyToken) {
    return drizzle(createD1Binding(proxyToken, CF_ACCOUNT_ID, CF_DATABASE_ID), { schema })
  }

  // 프로덕션 + 로컬 D1 fallback
  return drizzle(env.DB, { schema })
}

export type Db = ReturnType<typeof getDb>

export { schema }
