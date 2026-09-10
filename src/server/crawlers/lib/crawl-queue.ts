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

/**
 * 재크롤 간격(일). 크롤러 4종이 공유한다.
 *
 * 30 이면 정상 상태에서 큐가 절대 마르지 않는다:
 *   스코어링된 주차장 32,042곳 ÷ 30일 = 하루 1,068곳이 도래하는데
 *   naver/ddg 처리 능력은 50곳 × 12회 = 하루 600곳뿐이다.
 *   수요가 능력을 넘으면 뒤쪽 priority 는 영원히 선택되지 않는다.
 * 90 이면 수요가 356곳/일로 떨어져 능력 안에 들어오고,
 * 남는 244곳/일이 아직 한 번도 크롤 안 된 주차장으로 간다.
 *
 * 능력을 올리거나 주차장 수가 크게 늘면 이 값을 다시 계산할 것.
 */
export const RECRAWL_DAYS = 90

/**
 * 크롤 우선순위 식 (0 이 최우선).
 *
 * ⚠️ `parking_lot_stats` 에 행이 없는 주차장은 LEFT JOIN 이 NULL 이다.
 * 예전 식은 이걸 `ELSE 4`(최하위)로 보냈고, 그 결과 **한 번도 스코어링된 적 없는
 * 22,025곳(전체의 41%, web_sources 0건이 99.98%)이 큐의 맨 뒤**에 있었다.
 * 근거가 가장 없는 곳이 가장 늦게 크롤되는 역전이라 여기서 뒤집는다.
 *
 * ELSE 를 최하위가 아니라 중간(3)에 두는 것도 같은 이유다 —
 * 새 reliability 값이 생겨도 다시 기아 상태를 만들지 않는다.
 */
const PRIORITY_SQL = `CASE
      WHEN s.reliability IS NULL       THEN 0
      WHEN s.reliability = 'none'      THEN 1
      WHEN s.reliability = 'structural' THEN 2
      WHEN s.reliability = 'reference' THEN 3
      WHEN s.reliability = 'estimated' THEN 4
      WHEN s.reliability = 'confirmed' THEN 5
      ELSE 3 END`

/** 스크립트에서 같은 식을 쓰기 위해 노출한다 (scripts/reprice-crawl-queue.ts). */
export function crawlPrioritySql(): string {
  return PRIORITY_SQL
}

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
  const PRIORITY = PRIORITY_SQL

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

    // reliability 변동 반영.
    // `pinned_at IS NULL` — 사람이 고정한 우선순위(A-2 트래픽 기반)는 되돌리지 않는다.
    // `priority <> (...)` 비교는 lot 이 삭제된 고아 행에서 NULL 이 되어 자연히 제외된다.
    const upd = await db
      .prepare(
        `UPDATE crawl_queue
            SET priority = (
              SELECT ${PRIORITY} FROM parking_lots p
                LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
               WHERE p.id = crawl_queue.lot_id)
          WHERE crawler = ?1
            AND pinned_at IS NULL
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
