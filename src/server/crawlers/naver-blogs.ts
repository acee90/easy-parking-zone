/**
 * 네이버 블로그/카페 통합 크롤러 (Workers Cron용)
 *
 * 3가지 쿼리 전략으로 검색하고, 공통 파이프라인(필터→저장→매칭)을 거침.
 *
 * 쿼리 전략:
 *   A. 이름 기반: "{주차장명} 주차장"           — 고유한 이름
 *   B. POI 기반:  "{POI} 주차장"               — poi_tags 활용
 *   C. 지역 기반: "{동} 주차장 추천"            — 폴백
 *
 * B/C 전략 결과는 한 포스트에 여러 주차장이 언급될 수 있으므로
 * 앵커 lot에 직접 매칭 + 같은 배치 내 주차장 이름 스캔으로 다중 매칭.
 *
 * 네이버 검색 API 쿼타: 25,000/일
 * Workers Cron 타임아웃: 30초
 */
import {
  extractRegion,
  isGenericName,
  stripHtml,
  parsePostdate,
  hashUrl,
  scoreBlogRelevance,
} from "./lib/scoring";

/**
 * Workers Cron 제한: CPU 30초 (네트워크 대기 미포함), wall-clock 15분.
 * fetch() 대기는 CPU에 안 잡히므로 wall-clock 기준으로 여유 있게 설정.
 * 200개 × ~1.5초/lot = ~5분 (15분의 1/3, 여유 충분)
 */
const BATCH_SIZE = 200;
const DELAY = 300;
const RELEVANCE_THRESHOLD = 60;
const RESULTS_PER_QUERY = 5;
const RECRAWL_DAYS = 30;

const BLOG_URL = "https://openapi.naver.com/v1/search/blog.json";
const CAFE_URL = "https://openapi.naver.com/v1/search/cafearticle.json";

// ── 타입 ──

interface NaverSearchItem {
  title: string;
  link: string;
  description: string;
  bloggername?: string;
  cafename?: string;
  postdate?: string;
}

interface NaverSearchResponse {
  items: NaverSearchItem[];
}

interface LotRow {
  id: string;
  name: string;
  address: string;
  poi_tags: string | null;
}

type QueryStrategy = "name" | "poi" | "region";

interface CrawlQuery {
  strategy: QueryStrategy;
  query: string;
}

// ── 네이버 검색 ──

async function searchNaver(
  url: string,
  query: string,
  display: number,
  clientId: string,
  clientSecret: string,
): Promise<NaverSearchResponse> {
  const params = new URLSearchParams({ query, display: String(display), sort: "sim" });
  const res = await fetch(`${url}?${params}`, {
    headers: {
      "X-Naver-Client-Id": clientId,
      "X-Naver-Client-Secret": clientSecret,
    },
  });
  if (!res.ok) throw new Error(`Naver API ${res.status}: ${await res.text()}`);
  return res.json() as Promise<NaverSearchResponse>;
}

// ── 쿼리 전략 ──

/**
 * 주차장 데이터에 따라 쿼리 목록을 생성한다.
 *
 * A. 이름 기반 (고유한 이름이면 항상 포함)
 * B. POI 기반 (poi_tags가 있으면 추가)
 * C. 지역 기반 (A가 불가능할 때 폴백)
 */
function buildQueries(lot: LotRow): CrawlQuery[] {
  const region = extractRegion(lot.address);
  const queries: CrawlQuery[] = [];

  // A: 이름이 고유하면 항상 포함
  if (!isGenericName(lot.name)) {
    queries.push({ strategy: "name", query: `${lot.name} 주차장 ${region}`.trim() });
  }

  // B: POI 태그가 있으면 추가
  const poiTags: string[] = lot.poi_tags ? JSON.parse(lot.poi_tags) : [];
  if (poiTags.length > 0) {
    queries.push({ strategy: "poi", query: `${poiTags[0]} 주차장` });
  }

  // C: A도 B도 없으면 지역 폴백
  if (queries.length === 0) {
    queries.push({ strategy: "region", query: `${region} 주차장 추천` });
  }

  return queries;
}

// ── 다중 매칭 ──

/**
 * 검색 결과 텍스트에서 배치 내 다른 주차장 이름이 언급되는지 스캔.
 * B/C 전략 결과에서 한 포스트가 여러 주차장을 언급하는 경우를 포착.
 *
 * @returns 앵커 lot 외에 추가 매칭된 lot ID 배열
 */
function scanMultiMatches(
  title: string,
  description: string,
  anchorLotId: string,
  allLots: LotRow[],
): string[] {
  const combined = (stripHtml(title) + " " + stripHtml(description)).toLowerCase();
  const matched: string[] = [];

  for (const lot of allLots) {
    if (lot.id === anchorLotId) continue;
    if (isGenericName(lot.name)) continue;

    // 이름에서 핵심 키워드 추출
    const keywords = lot.name
      .toLowerCase()
      .replace(/주차장|공영|노외|노상|부설/g, "")
      .split(/\s+/)
      .filter((w) => w.length >= 2);

    if (keywords.length > 0 && keywords.some((kw) => combined.includes(kw))) {
      matched.push(lot.id);
    }
  }

  return matched;
}

// ── 우선순위 큐 ──

async function selectPriorityLots(
  db: D1Database,
  limit: number,
): Promise<LotRow[]> {
  const rows = await db
    .prepare(
      `SELECT p.id, p.name, p.address, p.poi_tags
       FROM parking_lots p
       LEFT JOIN parking_lot_stats s ON p.id = s.parking_lot_id
       LEFT JOIN crawl_progress cp
         ON cp.crawler_id = 'naver_blogs_lot:' || p.id
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
    .all<LotRow>();

  return rows.results ?? [];
}

// ── 공통 파이프라인: 검색 → 필터 → 저장 → 매칭 ──

interface SearchResult {
  insertBatch: D1PreparedStatement[];
  matchBatch: D1PreparedStatement[];
  saved: number;
}

async function processSearchResults(
  db: D1Database,
  items: NaverSearchItem[],
  source: "naver_blog" | "naver_cafe",
  lot: LotRow,
  crawlQuery: CrawlQuery,
  allLots: LotRow[],
): Promise<SearchResult> {
  const insertBatch: D1PreparedStatement[] = [];
  const matchBatch: D1PreparedStatement[] = [];
  let saved = 0;

  for (const item of items) {
    const score = scoreBlogRelevance(
      item.title, item.description, lot.name, lot.address,
    );
    if (score < RELEVANCE_THRESHOLD) continue;

    const sourceId = await hashUrl(item.link);
    const author = source === "naver_blog" ? (item.bloggername ?? "") : (item.cafename ?? "");

    // 1. web_sources에 저장 (앵커 lot에 직접 매칭)
    insertBatch.push(
      db.prepare(
        `INSERT OR IGNORE INTO web_sources
         (parking_lot_id, source, source_id, title, content, source_url, author, published_at, relevance_score)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      ).bind(
        lot.id, source, sourceId,
        stripHtml(item.title), stripHtml(item.description),
        item.link, author,
        parsePostdate(item.postdate), score,
      ),
    );
    saved++;

    // 2. POI/지역 전략: 다중 매칭 스캔
    if (crawlQuery.strategy !== "name") {
      const extraLotIds = scanMultiMatches(
        item.title, item.description, lot.id, allLots,
      );
      for (const lotId of extraLotIds) {
        matchBatch.push(
          db.prepare(
            `INSERT OR IGNORE INTO web_source_ai_matches
             (web_source_id, parking_lot_id, confidence, reason)
             SELECT id, ?1, 'medium', 'keyword_scan'
             FROM web_sources WHERE source_id = ?2
             LIMIT 1`,
          ).bind(lotId, sourceId),
        );
      }
    }
  }

  return { insertBatch, matchBatch, saved };
}

// ── 메인 배치 실행 ──

export async function runNaverBlogsBatch(
  db: D1Database,
  env: { NAVER_CLIENT_ID: string; NAVER_CLIENT_SECRET: string },
): Promise<{ processed: number; saved: number; matched: number; done: boolean }> {
  const lots = await selectPriorityLots(db, BATCH_SIZE);

  if (lots.length === 0) {
    return { processed: 0, saved: 0, matched: 0, done: true };
  }

  let saved = 0;
  let matched = 0;
  const allInserts: D1PreparedStatement[] = [];
  const allMatches: D1PreparedStatement[] = [];
  const progressBatch: D1PreparedStatement[] = [];

  for (const lot of lots) {
    const queries = buildQueries(lot);
    let lotSaved = 0;

    for (const cq of queries) {
      // 블로그 검색
      try {
        const blogRes = await searchNaver(
          BLOG_URL, cq.query, RESULTS_PER_QUERY,
          env.NAVER_CLIENT_ID, env.NAVER_CLIENT_SECRET,
        );
        const result = await processSearchResults(db, blogRes.items, "naver_blog", lot, cq, lots);
        allInserts.push(...result.insertBatch);
        allMatches.push(...result.matchBatch);
        lotSaved += result.saved;
        matched += result.matchBatch.length;
      } catch (err) {
        console.warn(`[naver-blogs] blog error (${lot.name}, ${cq.strategy}): ${(err as Error).message}`);
      }

      await new Promise((r) => setTimeout(r, DELAY));

      // 카페 검색
      try {
        const cafeRes = await searchNaver(
          CAFE_URL, cq.query, RESULTS_PER_QUERY,
          env.NAVER_CLIENT_ID, env.NAVER_CLIENT_SECRET,
        );
        const result = await processSearchResults(db, cafeRes.items, "naver_cafe", lot, cq, lots);
        allInserts.push(...result.insertBatch);
        allMatches.push(...result.matchBatch);
        lotSaved += result.saved;
        matched += result.matchBatch.length;
      } catch (err) {
        console.warn(`[naver-blogs] cafe error (${lot.name}, ${cq.strategy}): ${(err as Error).message}`);
      }

      await new Promise((r) => setTimeout(r, DELAY));
    }

    saved += lotSaved;

    progressBatch.push(
      db.prepare(
        `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
         VALUES (?1, ?2, ?3, datetime('now'))
         ON CONFLICT(crawler_id) DO UPDATE SET
           completed_count = completed_count + ?3, last_run_at = datetime('now')`,
      ).bind(`naver_blogs_lot:${lot.id}`, lot.id, lotSaved),
    );
  }

  // 배치 실행: INSERT → MATCH 순서 (INSERT 먼저 해야 서브쿼리 가능)
  if (allInserts.length > 0) {
    await db.batch(allInserts);
  }
  if (allMatches.length > 0) {
    await db.batch(allMatches);
  }
  if (progressBatch.length > 0) {
    await db.batch(progressBatch);
  }

  // 전체 진행 상태
  await db
    .prepare(
      `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
       VALUES ('naver_blogs', '', ?1, datetime('now'))
       ON CONFLICT(crawler_id) DO UPDATE SET
         completed_count = completed_count + ?1, last_run_at = datetime('now')`,
    )
    .bind(lots.length)
    .run();

  return { processed: lots.length, saved, matched, done: lots.length < BATCH_SIZE };
}
