/**
 * DuckDuckGo Search 크롤러 (crawl4ai 온프레미스 경유)
 *
 * API 키 불필요. crawl4ai로 DuckDuckGo HTML 검색결과를 크롤링하여
 * 제목/URL/설명을 파싱 후 web_sources에 저장.
 * Brave Search/Google CSE 대체용.
 */
import {
  extractRegion,
  isGenericName,
  stripHtml,
  hashUrl,
  scoreBlogRelevance,
} from "./lib/scoring";

/** 일일 배치 크기 (API 키 불필요, rate limit만 주의) */
const BATCH_SIZE = 50;
const RELEVANCE_THRESHOLD = 60;
const RECRAWL_DAYS = 30;
const DELAY = 1500; // DuckDuckGo rate limit 방지

const DDG_URL = "https://html.duckduckgo.com/html/";

interface DdgResult {
  title: string;
  url: string;
  description: string;
}

/**
 * crawl4ai를 통해 DuckDuckGo HTML 검색결과를 크롤링하고 파싱
 */
async function searchDuckDuckGo(
  query: string,
  crawl4aiUrl: string,
): Promise<DdgResult[]> {
  const searchUrl = `${DDG_URL}?q=${encodeURIComponent(query)}`;

  const res = await fetch(`${crawl4aiUrl}/crawl`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      urls: [searchUrl],
      word_count_threshold: 10,
    }),
  });

  if (!res.ok) {
    throw new Error(`crawl4ai error ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    success: boolean;
    results: Array<{
      html: string;
      markdown: { raw_markdown: string };
      status_code: number;
    }>;
  };

  if (!data.success || !data.results?.[0]) {
    throw new Error("crawl4ai returned no results");
  }

  const html = data.results[0].html;
  return parseDdgHtml(html);
}

/**
 * DuckDuckGo HTML에서 검색 결과 파싱
 *
 * 구조: <a class="result__a" href="...">제목</a>
 *       <a class="result__snippet">설명</a>
 */
function parseDdgHtml(html: string): DdgResult[] {
  const results: DdgResult[] = [];

  // DuckDuckGo redirect URL에서 실제 URL 추출
  const extractRealUrl = (ddgUrl: string): string | null => {
    const match = ddgUrl.match(/uddg=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
    // 직접 URL인 경우
    if (ddgUrl.startsWith("http")) return ddgUrl;
    return null;
  };

  // result__a 링크 + result__snippet 추출
  const resultBlockRegex =
    /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex =
    /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

  const titles: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;

  while ((match = resultBlockRegex.exec(html)) !== null) {
    const rawUrl = match[1];
    const realUrl = extractRealUrl(rawUrl);
    if (!realUrl) continue;
    titles.push({ url: realUrl, title: stripHtml(match[2]) });
  }

  const snippets: string[] = [];
  while ((match = snippetRegex.exec(html)) !== null) {
    snippets.push(stripHtml(match[1]));
  }

  for (let i = 0; i < titles.length; i++) {
    results.push({
      title: titles[i].title,
      url: titles[i].url,
      description: snippets[i] ?? "",
    });
  }

  return results;
}

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
         ON cp.crawler_id = 'ddg_lot:' || p.id
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

export async function runDuckDuckGoBatch(
  db: D1Database,
  env: { CRAWL4AI_URL: string },
): Promise<{
  processed: number;
  saved: number;
  queriesUsed: number;
  done: boolean;
  skipped?: boolean;
}> {
  // 하루 1회만 실행
  const lastRun = await db
    .prepare(
      "SELECT last_run_at FROM crawl_progress WHERE crawler_id = 'ddg_search'",
    )
    .first<{ last_run_at: string }>();
  if (lastRun?.last_run_at) {
    const lastDate = lastRun.last_run_at.slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    if (lastDate === today) {
      return { processed: 0, saved: 0, queriesUsed: 0, done: false, skipped: true };
    }
  }

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
        db
          .prepare(
            `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
           VALUES (?1, ?2, 0, datetime('now'))
           ON CONFLICT(crawler_id) DO UPDATE SET last_run_at = datetime('now')`,
          )
          .bind(`ddg_lot:${lot.id}`, lot.id),
      );
      continue;
    }

    const region = extractRegion(lot.address);
    const query = `"${lot.name}" ${region} 주차 후기`.trim();

    try {
      const items = await searchDuckDuckGo(query, env.CRAWL4AI_URL);
      await new Promise((r) => setTimeout(r, DELAY));
      queriesUsed++;

      for (const item of items) {
        const score = scoreBlogRelevance(
          item.title,
          item.description,
          lot.name,
          lot.address,
        );
        if (score < RELEVANCE_THRESHOLD) continue;

        const sourceId = await hashUrl(item.url);

        insertBatch.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO web_sources
             (parking_lot_id, source, source_id, title, content, source_url, relevance_score)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
            )
            .bind(
              lot.id,
              "ddg_search",
              sourceId,
              item.title,
              item.description,
              item.url,
              score,
            ),
        );
        saved++;
      }

      progressBatch.push(
        db
          .prepare(
            `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
           VALUES (?1, ?2, ?3, datetime('now'))
           ON CONFLICT(crawler_id) DO UPDATE SET
             completed_count = completed_count + ?3, last_run_at = datetime('now')`,
          )
          .bind(`ddg_lot:${lot.id}`, lot.id, items.length),
      );
    } catch (err) {
      console.log(
        `[ddg-search] Error for ${lot.name}: ${(err as Error).message}`,
      );
    }
  }

  const allStatements = [...insertBatch, ...progressBatch];
  const D1_BATCH_LIMIT = 500;
  for (let i = 0; i < allStatements.length; i += D1_BATCH_LIMIT) {
    await db.batch(allStatements.slice(i, i + D1_BATCH_LIMIT));
  }

  await db
    .prepare(
      `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
       VALUES ('ddg_search', '', ?1, datetime('now'))
       ON CONFLICT(crawler_id) DO UPDATE SET
         completed_count = completed_count + ?1, last_run_at = datetime('now')`,
    )
    .bind(queriesUsed)
    .run();

  return {
    processed: lots.length,
    saved,
    queriesUsed,
    done: lots.length < BATCH_SIZE,
  };
}
