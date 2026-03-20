/**
 * Brave Search 배치 크롤러 (Workers Cron용)
 *
 * 무료 2,000쿼리/월 한도 내에서 reliability가 낮은 주차장부터
 * 우선 크롤링하여 web_sources에 저장.
 * 네이버 검색에 없는 구글 인덱스 콘텐츠 보완용.
 */
import {
  extractRegion,
  isGenericName,
  stripHtml,
  hashUrl,
  scoreBlogRelevance,
} from "./lib/scoring";

/** 일일 배치 크기 (~66/일 = 2,000/월) */
const BATCH_SIZE = 66;
const RELEVANCE_THRESHOLD = 60;
/** 결과 없는 주차장 재크롤링 주기 (일) */
const RECRAWL_DAYS = 30;

const BRAVE_URL = "https://api.search.brave.com/res/v1/web/search";

interface BraveSearchResult {
  title: string;
  url: string;
  description: string;
  page_age?: string; // ISO date
  extra_snippets?: string[];
}

interface BraveSearchResponse {
  web?: { results: BraveSearchResult[] };
  query?: { original: string };
}

async function searchBrave(
  query: string,
  apiKey: string,
): Promise<BraveSearchResponse> {
  const params = new URLSearchParams({
    q: query,
    count: "5",
    country: "kr",
    search_lang: "ko",
  });
  const res = await fetch(`${BRAVE_URL}?${params}`, {
    headers: { "X-Subscription-Token": apiKey },
  });

  if (res.status === 429) {
    throw new QuotaExhaustedError(`Brave Search rate limited (429)`);
  }
  if (res.status === 402) {
    throw new QuotaExhaustedError(`Brave Search quota exhausted (402)`);
  }
  if (!res.ok) throw new Error(`Brave Search ${res.status}: ${await res.text()}`);
  return res.json() as Promise<BraveSearchResponse>;
}

class QuotaExhaustedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExhaustedError";
  }
}

/**
 * reliability 기반 우선순위 큐로 주차장을 선택한다.
 *
 * 1순위: reliability=none (데이터 전무)
 * 2순위: reliability=structural (물리 정보만)
 * 3순위: reliability=reference (데이터 희박)
 * 4순위: 마지막 크롤링 90일+ 경과
 */
async function selectPriorityLots(
  db: D1Database,
  limit: number,
): Promise<Array<{ id: string; name: string; address: string }>> {
  const rows = await db
    .prepare(
      `SELECT p.id, p.name, p.address
       FROM parking_lots p
       LEFT JOIN parking_lot_stats s ON p.id = s.parking_lot_id
       LEFT JOIN crawl_progress cp
         ON cp.crawler_id = 'brave_search_lot:' || p.id
       WHERE
         (cp.last_run_at IS NULL
          OR julianday('now') - julianday(cp.last_run_at) > ?1)
       ORDER BY
         CASE s.reliability
           WHEN 'none' THEN 0
           WHEN 'structural' THEN 1
           WHEN 'reference' THEN 2
           WHEN 'estimated' THEN 3
           ELSE 4
         END,
         cp.last_run_at ASC NULLS FIRST,
         p.id
       LIMIT ?2`,
    )
    .bind(RECRAWL_DAYS, limit)
    .all<{ id: string; name: string; address: string }>();

  return rows.results ?? [];
}

export async function runBraveSearchBatch(
  db: D1Database,
  env: { BRAVE_SEARCH_API_KEY: string },
): Promise<{ processed: number; saved: number; queriesUsed: number; done: boolean }> {
  const lots = await selectPriorityLots(db, BATCH_SIZE);

  if (lots.length === 0) {
    return { processed: 0, saved: 0, queriesUsed: 0, done: true };
  }

  let saved = 0;
  let queriesUsed = 0;
  const insertBatch: D1PreparedStatement[] = [];
  const progressBatch: D1PreparedStatement[] = [];

  for (const lot of lots) {
    if (isGenericName(lot.name)) {
      progressBatch.push(
        db.prepare(
          `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
           VALUES (?1, ?2, 0, datetime('now'))
           ON CONFLICT(crawler_id) DO UPDATE SET last_run_at = datetime('now')`,
        ).bind(`brave_search_lot:${lot.id}`, lot.id),
      );
      continue;
    }

    const region = extractRegion(lot.address);
    const query = `"${lot.name}" ${region} 주차 후기`.trim();

    try {
      const result = await searchBrave(query, env.BRAVE_SEARCH_API_KEY);
      queriesUsed++;

      const items = result.web?.results ?? [];
      for (const item of items) {
        const score = scoreBlogRelevance(item.title, item.description, lot.name, lot.address);
        if (score < RELEVANCE_THRESHOLD) continue;

        const sourceId = await hashUrl(item.url);
        const publishedAt = item.page_age?.slice(0, 10) ?? null;

        insertBatch.push(
          db.prepare(
            `INSERT OR IGNORE INTO web_sources
             (parking_lot_id, source, source_id, title, content, source_url, published_at, relevance_score)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
          ).bind(
            lot.id, "brave_search", sourceId,
            stripHtml(item.title), stripHtml(item.description),
            item.url, publishedAt, score,
          ),
        );
        saved++;
      }

      progressBatch.push(
        db.prepare(
          `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
           VALUES (?1, ?2, ?3, datetime('now'))
           ON CONFLICT(crawler_id) DO UPDATE SET
             completed_count = completed_count + ?3, last_run_at = datetime('now')`,
        ).bind(`brave_search_lot:${lot.id}`, lot.id, items.length),
      );
    } catch (err) {
      if (err instanceof QuotaExhaustedError) {
        console.log(`[brave-search] ${err.message} after ${queriesUsed} queries`);
        break;
      }
      console.log(`[brave-search] Error for ${lot.name}: ${(err as Error).message}`);
    }
  }

  const allStatements = [...insertBatch, ...progressBatch];
  if (allStatements.length > 0) {
    await db.batch(allStatements);
  }

  await db
    .prepare(
      `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
       VALUES ('brave_search', '', ?1, datetime('now'))
       ON CONFLICT(crawler_id) DO UPDATE SET
         completed_count = completed_count + ?1, last_run_at = datetime('now')`,
    )
    .bind(queriesUsed)
    .run();

  return { processed: lots.length, saved, queriesUsed, done: lots.length < BATCH_SIZE };
}
