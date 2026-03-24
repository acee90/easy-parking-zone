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

/** 일일 배치 크기 (subrequest 한도 고려하여 25로 제한) */
const BATCH_SIZE = 25;
const RELEVANCE_THRESHOLD = 60;
const RECRAWL_DAYS = 30;
const DELAY = 1500; // DuckDuckGo rate limit 방지
/** crawl4ai 개별 요청 타임아웃 (ms) */
const FETCH_TIMEOUT = 15_000;
/** 연속 실패 시 조기 중단 임계값 */
const MAX_CONSECUTIVE_FAILURES = 3;

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

/**
 * DuckDuckGo HTML에서 검색 결과 파싱
 *
 * result 블록 단위로 title + snippet을 함께 추출하여 인덱스 불일치 방지.
 */
function parseDdgHtml(html: string): DdgResult[] {
  const results: DdgResult[] = [];

  const extractRealUrl = (ddgUrl: string): string | null => {
    const match = ddgUrl.match(/uddg=([^&]+)/);
    if (match) return decodeURIComponent(match[1]);
    if (ddgUrl.startsWith("http")) return ddgUrl;
    return null;
  };

  // result 블록 단위로 추출 (class="result results_links" 또는 유사 블록)
  const resultBlockRegex =
    /<div[^>]+class="[^"]*result[^"]*results_links[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]+class="[^"]*result|$)/gi;

  // 개별 블록 내에서 title과 snippet 추출 (class/href 순서 무관)
  const titleRegex =
    /<a[^>]*(?:class="result__a"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*class="result__a")[^>]*>([\s\S]*?)<\/a>/i;
  const snippetRegex =
    /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i;

  let blockMatch: RegExpExecArray | null;
  while ((blockMatch = resultBlockRegex.exec(html)) !== null) {
    const block = blockMatch[1];
    const tMatch = titleRegex.exec(block);
    if (!tMatch) continue;

    const rawUrl = tMatch[1] || tMatch[2];
    const realUrl = extractRealUrl(rawUrl);
    if (!realUrl) continue;

    const sMatch = snippetRegex.exec(block);

    results.push({
      title: stripHtml(tMatch[3]),
      url: realUrl,
      description: sMatch ? stripHtml(sMatch[1]) : "",
    });
  }

  // 폴백: 블록 매칭 실패 시 기존 방식 (독립 매칭)
  if (results.length === 0) {
    const titleFallback =
      /<a[^>]*(?:class="result__a"[^>]*href="([^"]+)"|href="([^"]+)"[^>]*class="result__a")[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetFallback =
      /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

    const titles: Array<{ url: string; title: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = titleFallback.exec(html)) !== null) {
      const rawUrl = match[1] || match[2];
      const realUrl = extractRealUrl(rawUrl);
      if (!realUrl) continue;
      titles.push({ url: realUrl, title: stripHtml(match[3]) });
    }

    const snippets: string[] = [];
    while ((match = snippetFallback.exec(html)) !== null) {
      snippets.push(stripHtml(match[1]));
    }

    for (let i = 0; i < titles.length; i++) {
      results.push({
        title: titles[i].title,
        url: titles[i].url,
        description: snippets[i] ?? "",
      });
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
  changedLotIds: string[];
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
      return { processed: 0, saved: 0, queriesUsed: 0, done: false, skipped: true, changedLotIds: [] };
    }
  }

  const lots = await selectPriorityLots(db, BATCH_SIZE);

  if (lots.length === 0) {
    return { processed: 0, saved: 0, queriesUsed: 0, done: true, changedLotIds: [] };
  }

  let saved = 0;
  let queriesUsed = 0;
  let consecutiveFailures = 0;
  const changedLotIds: string[] = [];
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
      consecutiveFailures = 0; // 성공 시 리셋

      let lotSaved = 0;
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
        lotSaved++;
      }

      if (lotSaved > 0) {
        changedLotIds.push(lot.id);
        saved += lotSaved;
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
    changedLotIds,
  };
}
