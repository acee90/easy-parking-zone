import { env } from 'cloudflare:workers'
import { createFileRoute } from '@tanstack/react-router'
import { sql } from 'drizzle-orm'
import { getDb } from '@/db'
import { encodePoint, type ParkingPoint } from '@/lib/points'
import { getClientIP } from '@/server/rate-limit'

/**
 * GET /api/points — 전체 주차장 경량 좌표 (B-3). 형식은 `src/lib/points.ts`.
 *
 * 캐시는 1시간 TTL 만 쓴다. 예전 서버 함수는 캐시 적중을 확인하려고 요청마다
 * `COUNT(*)·MAX(updated_at) FROM parking_lots` 로 5.4만 행을 읽었다 (지도 1회 방문 = 5.4만 rows_read).
 * 대가: lot 추가·병합·삭제가 지도 점에 반영되기까지 최대 1시간. 지워진 id 는 목록 조회에서 빠질 뿐이다.
 * 형식을 바꾸면 CACHE_KEY 버전을 올린다 — 옛 본문이 남지 않도록.
 */
const CACHE_KEY = 'https://cache.internal/parking-points-v3'
const TTL_SECONDS = 3600

async function handlePoints(request: Request): Promise<Response> {
  const ip = getClientIP(request)
  if (ip !== 'unknown') {
    const { success } = await env.RATE_LIMITER_POINTS.limit({ key: ip })
    if (!success) return new Response('Too Many Requests', { status: 429 })
  }

  const cache = typeof caches !== 'undefined' ? await caches.open('parking-points') : null
  const cached = await cache?.match(CACHE_KEY)
  if (cached) return cached

  const rows = (await getDb().all(
    sql.raw(
      `SELECT p.id, p.lat, p.lng, s.final_score AS score
       FROM parking_lots p
       LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id`,
    ),
  )) as ParkingPoint[]

  const response = new Response(JSON.stringify(rows.map(encodePoint)), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${TTL_SECONDS}`,
    },
  })
  await cache?.put(CACHE_KEY, response.clone()).catch(() => {}) // 캐시 쓰기 실패는 무시
  return response
}

export const Route = createFileRoute('/api/points')({
  server: {
    handlers: {
      GET: ({ request }) => handlePoints(request),
    },
  },
})
