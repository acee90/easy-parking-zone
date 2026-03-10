/**
 * 네이버 블로그/카페 배치 크롤러 (Workers Cron용)
 *
 * D1 바인딩 직접 사용, 파일시스템 의존 없음.
 * 한 번 실행에 BATCH_SIZE개 주차장만 처리 (micro-batching).
 */
import {
  extractRegion,
  isGenericName,
  stripHtml,
  parsePostdate,
  hashUrl,
  scoreBlogRelevance,
} from "./lib/scoring";

const BATCH_SIZE = 10;
const DELAY = 300;
const RELEVANCE_THRESHOLD = 40;
const RESULTS_PER_QUERY = 5;

const BLOG_URL = "https://openapi.naver.com/v1/search/blog.json";
const CAFE_URL = "https://openapi.naver.com/v1/search/cafearticle.json";

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

async function searchNaver(
  url: string,
  query: string,
  display: number,
  clientId: string,
  clientSecret: string
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

export async function runNaverBlogsBatch(
  db: D1Database,
  env: { NAVER_CLIENT_ID: string; NAVER_CLIENT_SECRET: string }
): Promise<{ processed: number; saved: number; done: boolean }> {
  // 진행 상태 조회
  const progress = await db
    .prepare("SELECT last_parking_lot_id, completed_count FROM crawl_progress WHERE crawler_id = 'naver_blogs'")
    .first<{ last_parking_lot_id: string | null; completed_count: number }>();

  const cursor = progress?.last_parking_lot_id ?? "";
  const completedCount = progress?.completed_count ?? 0;

  // 다음 배치 주차장 조회
  const lots = await db
    .prepare("SELECT id, name, address FROM parking_lots WHERE id > ?1 ORDER BY id LIMIT ?2")
    .bind(cursor, BATCH_SIZE)
    .all<{ id: string; name: string; address: string }>();

  if (!lots.results || lots.results.length === 0) {
    return { processed: 0, saved: 0, done: true };
  }

  let saved = 0;
  const batch: D1PreparedStatement[] = [];

  for (const lot of lots.results) {
    if (isGenericName(lot.name)) continue;

    const region = extractRegion(lot.address);
    const query = `${lot.name} 주차장 ${region}`.trim();

    // 블로그 검색
    try {
      const blogRes = await searchNaver(BLOG_URL, query, RESULTS_PER_QUERY, env.NAVER_CLIENT_ID, env.NAVER_CLIENT_SECRET);
      for (const item of blogRes.items) {
        const score = scoreBlogRelevance(item.title, item.description, lot.name, lot.address);
        if (score < RELEVANCE_THRESHOLD) continue;

        const sourceId = await hashUrl(item.link);
        batch.push(
          db.prepare(
            "INSERT OR IGNORE INTO web_sources (parking_lot_id, source, source_id, title, content, source_url, author, published_at, relevance_score) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
          ).bind(
            lot.id, "naver_blog", sourceId,
            stripHtml(item.title), stripHtml(item.description),
            item.link, item.bloggername ?? "",
            parsePostdate(item.postdate), score
          )
        );
        saved++;
      }
    } catch { /* skip on error */ }

    await new Promise((r) => setTimeout(r, DELAY));

    // 카페 검색
    try {
      const cafeRes = await searchNaver(CAFE_URL, query, RESULTS_PER_QUERY, env.NAVER_CLIENT_ID, env.NAVER_CLIENT_SECRET);
      for (const item of cafeRes.items) {
        const score = scoreBlogRelevance(item.title, item.description, lot.name, lot.address);
        if (score < RELEVANCE_THRESHOLD) continue;

        const sourceId = await hashUrl(item.link);
        batch.push(
          db.prepare(
            "INSERT OR IGNORE INTO web_sources (parking_lot_id, source, source_id, title, content, source_url, author, published_at, relevance_score) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)"
          ).bind(
            lot.id, "naver_cafe", sourceId,
            stripHtml(item.title), stripHtml(item.description),
            item.link, item.cafename ?? "",
            parsePostdate(item.postdate), score
          )
        );
        saved++;
      }
    } catch { /* skip on error */ }

    await new Promise((r) => setTimeout(r, DELAY));
  }

  // 배치 실행
  if (batch.length > 0) {
    await db.batch(batch);
  }

  // 진행 상태 업데이트
  const lastId = lots.results[lots.results.length - 1].id;
  const newCount = completedCount + lots.results.length;

  await db
    .prepare(
      `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
       VALUES ('naver_blogs', ?1, ?2, datetime('now'))
       ON CONFLICT(crawler_id) DO UPDATE SET
         last_parking_lot_id = ?1, completed_count = ?2, last_run_at = datetime('now')`
    )
    .bind(lastId, newCount)
    .run();

  return { processed: lots.results.length, saved, done: false };
}
