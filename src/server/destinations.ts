/**
 * 목적지 축 페이지 (#166) — /near/{목적지} 서버 함수
 *
 * 전부 읽기다. destinations 에 행을 만드는 유일한 경로는 scripts/near/evaluate-candidates.ts 이고,
 * 그 스크립트는 게이트를 통과한 목적지만 SQL 로 낸다. 여기서는 "행이 있으면 발행" 이라고 믿고 읽는다.
 * db.run() 은 로컬 miniflare 에서 rows 가 비므로 db.all() 만 쓴다.
 */
import { createServerFn } from '@tanstack/react-start'
import { sql } from 'drizzle-orm'
import { getDb } from '@/db'
import type { BlogPost, Destination, DestinationLink, DestinationLot } from '@/types/parking'
import {
  type BlogPostRow,
  type DestinationLinkRow,
  type DestinationLotRow,
  type DestinationRow,
  rowToBlogPost,
  rowToDestination,
  rowToDestinationLink,
  rowToDestinationLot,
} from './transforms'

const DEST_ID = /^D-\d{1,8}$/

function validateDestinationId(input: { destinationId: string }) {
  if (!DEST_ID.test(input.destinationId)) throw new Error('invalid destinationId')
  return input
}

/** 페이지 loader. 없으면 null → 라우트가 notFound() */
export const fetchDestination = createServerFn({ method: 'GET' })
  .inputValidator((input: { id: string }): { id: string } => {
    if (!DEST_ID.test(input.id)) throw new Error('invalid id')
    return input
  })
  .handler(async ({ data }): Promise<Destination | null> => {
    const db = getDb()
    const rows = await db.all(
      sql`SELECT id, name, slug, category, lat, lng, address, lot_count, free_count, published_at
          FROM destinations WHERE id = ${data.id} LIMIT 1`,
    )
    const row = (rows as unknown as DestinationRow[])[0]
    return row ? rowToDestination(row) : null
  })

/** 비교표. 미리 계산된 destination_lots 를 rank 순으로 */
export const fetchDestinationLots = createServerFn({ method: 'GET' })
  .inputValidator(validateDestinationId)
  .handler(async ({ data }): Promise<DestinationLot[]> => {
    const db = getDb()
    const rows = await db.all(
      sql`SELECT p.*,
            s.final_score AS avg_score,
            COALESCE(s.review_count, 0) AS review_count,
            s.reliability,
            dl.distance_m, dl.walk_minutes, dl.rank, dl.evidence
          FROM destination_lots dl
          JOIN parking_lots p ON p.id = dl.parking_lot_id
          LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
          WHERE dl.destination_id = ${data.destinationId}
          ORDER BY dl.rank ASC`,
    )
    return (rows as unknown as DestinationLotRow[]).map(rowToDestinationLot)
  })

/**
 * 실제 후기 인용. destination_lots.evidence 가 가리키는 web_source 만 —
 * 즉 이 목적지 이름을 실제로 담은 글만 — 최대 3건.
 * 경쟁사가 "제가 갔을 때는" 을 지어내는 자리에 들어가는 것이라, 조건을 느슨하게 하지 않는다.
 */
export const fetchDestinationSnippets = createServerFn({ method: 'GET' })
  .inputValidator(validateDestinationId)
  .handler(async ({ data }): Promise<BlogPost[]> => {
    const db = getDb()
    const rows = await db.all(
      sql`SELECT w.id, w.title, w.content, w.ai_summary AS summary, w.source_url, w.source,
            w.author, w.published_at, w.relevance_score
          FROM destination_lots dl
          JOIN web_sources w
            ON w.id = CAST(substr(dl.evidence, length('web_source:') + 1) AS INTEGER)
          WHERE dl.destination_id = ${data.destinationId}
            AND dl.evidence LIKE 'web_source:%'
            AND w.relevance_score >= 40
            AND w.filter_passed_v2 = 1
          ORDER BY w.relevance_score DESC, dl.rank ASC
          LIMIT 3`,
    )
    return (rows as unknown as BlogPostRow[]).map(rowToBlogPost)
  })

/** 주차장 상세페이지의 "이 주차장으로 갈 수 있는 곳". idx_destination_lots_lot 을 탄다 */
export const fetchDestinationsForLot = createServerFn({ method: 'GET' })
  .inputValidator((input: { parkingLotId: string }): { parkingLotId: string } => {
    if (!input.parkingLotId || input.parkingLotId.length > 64)
      throw new Error('invalid parkingLotId')
    return input
  })
  .handler(async ({ data }): Promise<DestinationLink[]> => {
    const db = getDb()
    const rows = await db.all(
      sql`SELECT d.id, d.name, d.slug, d.category, dl.distance_m
          FROM destination_lots dl
          JOIN destinations d ON d.id = dl.destination_id
          WHERE dl.parking_lot_id = ${data.parkingLotId}
          ORDER BY dl.distance_m ASC
          LIMIT 6`,
    )
    return (rows as unknown as DestinationLinkRow[]).map(rowToDestinationLink)
  })
