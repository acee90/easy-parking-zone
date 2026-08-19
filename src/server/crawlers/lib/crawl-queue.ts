/**
 * 크롤 대상 선정 큐 (migration 0052).
 *
 * 기존 selectPriorityLots 는 상위 N개를 고르려고 parking_lots 31,994행을 매번 스캔했다.
 * ORDER BY 1순위가 LEFT JOIN 된 parking_lot_stats.reliability 라 어떤 인덱스도 그 정렬을
 * 서빙할 수 없어서(인덱스 추가를 실측했으나 EXPLAIN 계획 불변) 구조적으로 회피가 불가능했다.
 *
 * crawl_queue 는 (crawler, priority, next_at) 을 물리화해 선정을 인덱스 범위 조회로 만든다.
 *   EXPLAIN: SEARCH q USING COVERING INDEX idx_crawl_queue_pick (crawler=?)
 *   → 호출당 약 96,000행 → ~50행
 */

export interface QueueLotRow {
  id: string
  name: string
  address: string
}

export type CrawlerKey = 'naver_blogs' | 'ddg' | 'youtube' | 'brave_search'

/** 크롤 대상 선정 — priority 오름차순, 같은 priority 안에서는 오래된 것부터. */
export async function selectFromQueue(
  db: D1Database,
  crawler: CrawlerKey,
  limit: number,
): Promise<QueueLotRow[]> {
  const rows = await db
    .prepare(
      `SELECT p.id, p.name, p.address
         FROM crawl_queue q
         JOIN parking_lots p ON p.id = q.lot_id
        WHERE q.crawler = ?1 AND q.next_at <= datetime('now')
        ORDER BY q.priority, q.next_at
        LIMIT ?2`,
    )
    .bind(crawler, limit)
    .all<QueueLotRow>()
  return rows.results ?? []
}

/**
 * 크롤 완료 표시 — 다음 크롤 가능 시각을 미룬다.
 * 배치에 넣어 실행할 수 있도록 statement 를 반환한다.
 */
export function bumpQueue(
  db: D1Database,
  crawler: CrawlerKey,
  lotId: string,
  recrawlDays: number,
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE crawl_queue SET next_at = datetime('now', '+' || ?3 || ' day')
        WHERE crawler = ?1 AND lot_id = ?2`,
    )
    .bind(crawler, lotId, recrawlDays)
}

/**
 * 큐 동기화 — 신규 주차장 추가분을 넣고, 스코어링으로 바뀐 reliability 를 priority 에 반영한다.
 *
 * 전 주차장을 훑으므로 비싸다(크롤러 4종 × 31,994행). **하루 1회만** 호출할 것.
 * 매 사이클 돌리면 이 모듈이 없애려던 비용이 그대로 돌아온다.
 */
export async function syncQueue(db: D1Database): Promise<{ inserted: number; repriced: number }> {
  const CRAWLERS: Array<[CrawlerKey, string]> = [
    ['naver_blogs', 'naver_blogs_lot:'],
    ['ddg', 'ddg_lot:'],
    ['youtube', 'youtube_lot:'],
    ['brave_search', 'brave_search_lot:'],
  ]
  const PRIORITY = `CASE s.reliability
      WHEN 'none' THEN 0 WHEN 'structural' THEN 1
      WHEN 'reference' THEN 2 WHEN 'estimated' THEN 3 ELSE 4 END`

  let inserted = 0
  let repriced = 0

  for (const [crawler] of CRAWLERS) {
    // 신규 lot: 즉시 크롤 대상으로 넣는다
    const ins = await db
      .prepare(
        `INSERT OR IGNORE INTO crawl_queue (crawler, lot_id, priority, next_at)
         SELECT ?1, p.id, ${PRIORITY}, '2000-01-01 00:00:00'
           FROM parking_lots p
           LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id`,
      )
      .bind(crawler)
      .run()
    inserted += ins.meta?.changes ?? 0

    // reliability 변동 반영
    const upd = await db
      .prepare(
        `UPDATE crawl_queue
            SET priority = (
              SELECT ${PRIORITY} FROM parking_lots p
                LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
               WHERE p.id = crawl_queue.lot_id)
          WHERE crawler = ?1
            AND priority <> (
              SELECT ${PRIORITY} FROM parking_lots p
                LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
               WHERE p.id = crawl_queue.lot_id)`,
      )
      .bind(crawler)
      .run()
    repriced += upd.meta?.changes ?? 0
  }

  return { inserted, repriced }
}
