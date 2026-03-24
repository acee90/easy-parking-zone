/**
 * DuckDuckGo Search 크롤러 (crawl4ai 온프레미스 경유)
 *
 * API 키 불필요. crawl4ai로 DuckDuckGo HTML 검색결과를 크롤링하여
 * 제목/URL/설명을 파싱 후 web_sources_raw에 URL 단위로 저장.
 * 매칭/필터링은 별도 단계에서 처리.
 */
import {
  extractRegion,
  isGenericName,
  stripHtml,
  hashUrl,
} from "./lib/scoring";

/** 일일 배치 크기 (subrequest 한도 고려하여 25로 제한) */
const BATCH_SIZE = 25;
const RECRAWL_DAYS = 30;
const DELAY = 1500; // DuckDuckGo rate limit 방지
const FETCH_TIMEOUT = 15_000;
const MAX_CONSECUTIVE_FAILURES = 3;

const DDG_URL = "https://html.duckduckgo.com/html/";

interface DdgResult {
  title: string;
  url: string;
  description: string;
}

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
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
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
  if (!html || html.length < 100) return [];

  return parseDdgHtml(html);
}

function parseDdgHtml(html: string): DdgResult[] {
  const results: DdgResult[] = [];

  const extractRealUrl = (ddgUrl: string): string | null => {
    const match = ddgUrl.match(/uddg=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
    if (ddgUrl.startsWith("http")) return ddgUrl;
    return null;
  };

  const blockRe =
    /<div[^>]+class="[^"]*result[^"]*results_links[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]+class="[^"]*result|$)/gi;
  const titleRe =
    /<a[^>]*(?:class="result__a"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*class="result__a")[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRe =
    /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;

  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[1];
    const t = titleRe.exec(block);
    if (!t) continue;
    const realUrl = extractRealUrl(t[1] || t[2]);
    if (!realUrl) continue;
    const s = snippetRe.exec(block);
    results.push({
      title: stripHtml(t[3]),
      url: realUrl,
      description: s ? stripHtml(s[1]) : "",
    });
  }

  // 폴백
  if (results.length === 0) {
    const titleFb =
      /<a[^>]*(?:class="result__a"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*class="result__a")[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetFb =
      /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const titles: Array<{ url: string; title: string }> = [];
    while ((m = titleFb.exec(html)) !== null) {
      const url = extractRealUrl(m[1] || m[2]);
      if (url) titles.push({ url, title: stripHtml(m[3]) });
    }
    const snippets: string[] = [];
    while ((m = snippetFb.exec(html)) !== null) snippets.push(stripHtml(m[1]));

    for (let i = 0; i < titles.length; i++) {
      results.push({ ...titles[i], description: snippets[i] ?? "" });
    }
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
  let consecutiveFailures = 0;
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
      consecutiveFailures = 0;

      for (const item of items) {
        const sourceId = await hashUrl(item.url);

        insertBatch.push(
          db
            .prepare(
              `INSERT OR IGNORE INTO web_sources_raw
             (source, source_id, source_url, title, content)
             VALUES (?1, ?2, ?3, ?4, ?5)`,
            )
            .bind(
              "ddg_search",
              sourceId,
              item.url,
              item.title,
              item.description,
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
      consecutiveFailures++;
      console.log(
        `[ddg-search] Error for ${lot.name} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${(err as Error).message}`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.log(`[ddg-search] ${MAX_CONSECUTIVE_FAILURES} consecutive failures, stopping batch`);
        break;
      }
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
