/**
 * Brave Search 배치 크롤러 (Workers Cron용)
 *
 * 무료 2,000쿼리/월 한도 내에서 reliability가 낮은 주차장부터
 * 우선 크롤링하여 web_sources_raw에 저장.
 * 네이버 검색에 없는 구글 인덱스 콘텐츠 보완용.
 */

import { isAggregatorUrl } from './lib/aggregator-domains'
import { bumpQueue, RECRAWL_DAYS, selectFromQueue } from './lib/crawl-queue'
import { extractRegion, hashUrl, isGenericName, stripHtml } from './lib/scoring'

/** 일일 배치 크기 (~66/일 = 2,000/월) */
const BATCH_SIZE = 66

const BRAVE_URL = 'https://api.search.brave.com/res/v1/web/search'
const DELAY = 200

class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuotaExhaustedError'
  }
}

interface BraveSearchResult {
  title: string
  url: string
  description: string
  page_age?: string // ISO date
  extra_snippets?: string[]
}

interface BraveSearchResponse {
  web?: { results: BraveSearchResult[] }
  query?: { original: string }
}

async function searchBrave(query: string, apiKey: string): Promise<BraveSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    count: '5',
    country: 'kr',
    search_lang: 'ko',
  })
  const res = await fetch(`${BRAVE_URL}?${params}`, {
    headers: { 'X-Subscription-Token': apiKey },
  })

  if (res.status === 429) {
    throw new QuotaExhaustedError(`Brave Search rate limited (429)`)
  }
  if (res.status === 402) {
    throw new QuotaExhaustedError(`Brave Search quota exhausted (402)`)
  }
  if (!res.ok) throw new Error(`Brave Search ${res.status}: ${await res.text()}`)
  return res.json() as Promise<BraveSearchResponse>
}

/**
 * reliability 기반 우선순위 큐로 주차장을 선택한다.
 *
 * 1순위: reliability=none (데이터 전무)
 * 2순위: reliability=structural (물리 정보만)
 * 3순위: reliability=reference (데이터 희박)
 * 4순위: 마지막 크롤링 30일+ 경과
 */
async function selectPriorityLots(
  db: D1Database,
  limit: number,
): Promise<Array<{ id: string; name: string; address: string }>> {
  // crawl_queue 인덱스 조회로 위임 (0052). 과거에는 parking_lots 31,994행을 매번
  // 스캔했다 — ORDER BY 1순위가 LEFT JOIN 된 reliability 라 인덱스 불가였다.
  return selectFromQueue(db, 'brave_search', limit)
}

export async function runBraveSearchBatch(
  db: D1Database,
  env: { BRAVE_SEARCH_API_KEY: string },
): Promise<{
  processed: number
  saved: number
  queriesUsed: number
  done: boolean
  skipped?: boolean
}> {
  // 하루 1회만 실행 (무료 2,000쿼리/월 = ~66/일)
  const lastRun = await db
    .prepare("SELECT last_run_at FROM crawl_progress WHERE crawler_id = 'brave_search'")
    .first<{ last_run_at: string }>()
  if (lastRun?.last_run_at) {
    const lastDate = lastRun.last_run_at.slice(0, 10)
    const today = new Date().toISOString().slice(0, 10)
    if (lastDate === today) {
      return { processed: 0, saved: 0, queriesUsed: 0, done: false, skipped: true }
    }
  }

  const lots = await selectPriorityLots(db, BATCH_SIZE)

  if (lots.length === 0) {
    return { processed: 0, saved: 0, queriesUsed: 0, done: true }
  }

  let saved = 0
  let queriesUsed = 0
  const insertBatch: D1PreparedStatement[] = []
  const progressBatch: D1PreparedStatement[] = []

  for (const lot of lots) {
    if (isGenericName(lot.name)) {
      progressBatch.push(
        // crawl_queue 의 next_at 도 함께 미룬다 (0052)
        bumpQueue(db, 'brave_search', lot.id, RECRAWL_DAYS),
        db
          .prepare(
            `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
           VALUES (?1, ?2, 0, datetime('now'))
           ON CONFLICT(crawler_id) DO UPDATE SET last_run_at = datetime('now')`,
          )
          .bind(`brave_search_lot:${lot.id}`, lot.id),
      )
      continue
    }

    const region = extractRegion(lot.address)
    const query = `"${lot.name}" ${region} 주차 후기`.trim()

    try {
      const result = await searchBrave(query, env.BRAVE_SEARCH_API_KEY)
      await new Promise((r) => setTimeout(r, DELAY))
      queriesUsed++

      const items = result.web?.results ?? []
      for (const item of items) {
        // 정보 모음 사이트는 수집 단계에서 버린다 — 본문 fetch 예산까지 아낀다
        if (isAggregatorUrl(item.url)) continue
        const sourceId = await hashUrl(item.url)
        const publishedAt = item.page_age?.slice(0, 10) ?? null

        // 중복 판정은 seen_sources 로 한다 (0050). web_sources_raw 는 처리 완료 후
        // 삭제되는 임시 데이터라 UNIQUE 제약만으로는 재크롤을 막지 못한다.
        insertBatch.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO web_sources_raw
             (source, source_id, source_url, title, content, published_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6
              WHERE NOT EXISTS (
                SELECT 1 FROM seen_sources WHERE source = ?1 AND source_id = ?2)`,
            )
            .bind(
              'brave_search',
              sourceId,
              item.url,
              stripHtml(item.title),
              stripHtml(item.description),
              publishedAt,
            ),
          db
            .prepare(`INSERT OR IGNORE INTO seen_sources (source, source_id) VALUES (?1, ?2)`)
            .bind('brave_search', sourceId),
        )
        saved++
      }

      progressBatch.push(
        // crawl_queue 의 next_at 도 함께 미룬다 (0052)
        bumpQueue(db, 'brave_search', lot.id, RECRAWL_DAYS),
        db
          .prepare(
            `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
           VALUES (?1, ?2, ?3, datetime('now'))
           ON CONFLICT(crawler_id) DO UPDATE SET
             completed_count = completed_count + ?3, last_run_at = datetime('now')`,
          )
          .bind(`brave_search_lot:${lot.id}`, lot.id, items.length),
      )
    } catch (err) {
      if (err instanceof QuotaExhaustedError) {
        console.log(`[brave-search] ${err.message} after ${queriesUsed} queries`)
        break
      }
      console.log(`[brave-search] Error for ${lot.name}: ${(err as Error).message}`)
    }
  }

  const allStatements = [...insertBatch, ...progressBatch]
  const D1_BATCH_LIMIT = 500
  for (let i = 0; i < allStatements.length; i += D1_BATCH_LIMIT) {
    await db.batch(allStatements.slice(i, i + D1_BATCH_LIMIT))
  }

  await db
    .prepare(
      `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
       VALUES ('brave_search', '', ?1, datetime('now'))
       ON CONFLICT(crawler_id) DO UPDATE SET
         completed_count = completed_count + ?1, last_run_at = datetime('now')`,
    )
    .bind(queriesUsed)
    .run()

  return { processed: lots.length, saved, queriesUsed, done: lots.length < BATCH_SIZE }
}
