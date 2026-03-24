/**
 * DuckDuckGo 크롤링 스크립트 (crawl4ai 온프레미스 경유)
 *
 * cron(scheduled.ts)과 crawl_progress 테이블을 공유하여
 * 동일한 우선순위 큐에서 작동. 로컬에서 대량 처리 가능.
 *
 * Usage:
 *   bun run scripts/crawl-ddg.ts                    # 로컬 DB, 25건
 *   bun run scripts/crawl-ddg.ts --remote            # 리모트 D1
 *   bun run scripts/crawl-ddg.ts --remote --limit 100 # 100건 처리
 *   bun run scripts/crawl-ddg.ts --dry-run            # DB 저장 없이 결과만 출력
 *
 * 환경변수:
 *   CRAWL4AI_URL (기본값: https://crawl.arttoken.biz)
 */
import { resolve } from "path";
import { d1Query, d1Execute, isRemote } from "./lib/d1";
import { extractRegion, isGenericName } from "./lib/geo";
import { loadProgress, saveProgress } from "./lib/progress";
import { hashUrl, stripHtml, scoreBlogRelevance } from "../src/server/crawlers/lib/scoring";
import { buildInsert, flushStatements } from "./lib/sql-flush";

// ── CLI 옵션 ──
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 25;

const CRAWL4AI_URL = process.env.CRAWL4AI_URL ?? "https://crawl.arttoken.biz";
const RELEVANCE_THRESHOLD = 60;
const DELAY = 1500;
const FETCH_TIMEOUT = 15_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const DB_FLUSH_SIZE = 50;
const RECRAWL_DAYS = 30;

const PROGRESS_JSON = resolve(import.meta.dir, "ddg-progress.json");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-ddg.sql");

const DDG_URL = "https://html.duckduckgo.com/html/";

// ── Types ──
interface LotRow {
  id: string;
  name: string;
  address: string;
  reliability: string | null;
}

interface DdgResult {
  title: string;
  url: string;
  description: string;
}

interface Progress {
  completedIds: string[];
  totalQueries: number;
  savedSources: number;
  skippedGeneric: number;
  skippedLowRelevance: number;
  startedAt: string;
  lastUpdatedAt: string;
}

// ── crawl4ai + DuckDuckGo ──
async function searchDuckDuckGo(query: string): Promise<DdgResult[]> {
  const searchUrl = `${DDG_URL}?q=${encodeURIComponent(query)}`;

  const res = await fetch(`${CRAWL4AI_URL}/crawl`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ urls: [searchUrl], word_count_threshold: 10 }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  if (!res.ok) throw new Error(`crawl4ai ${res.status}`);

  const data = (await res.json()) as {
    success: boolean;
    results: Array<{ html: string }>;
  };

  if (!data.success || !data.results?.[0]) throw new Error("no results");

  const html = data.results[0].html;
  if (!html || html.length < 100) return [];

  return parseDdgHtml(html);
}

function parseDdgHtml(html: string): DdgResult[] {
  const results: DdgResult[] = [];

  const extractRealUrl = (ddgUrl: string): string | null => {
    const m = ddgUrl.match(/uddg=([^&]+)/);
    if (m) return decodeURIComponent(m[1]);
    if (ddgUrl.startsWith("http")) return ddgUrl;
    return null;
  };

  // 블록 단위 파싱
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

// ── 우선순위 큐 (cron과 동일한 crawl_progress 참조) ──
function selectPriorityLots(limit: number): LotRow[] {
  return d1Query<LotRow>(
    `SELECT p.id, p.name, p.address, s.reliability
     FROM parking_lots p
     LEFT JOIN parking_lot_stats s ON p.id = s.parking_lot_id
     LEFT JOIN crawl_progress cp ON cp.crawler_id = 'ddg_lot:' || p.id
     WHERE cp.last_run_at IS NULL
        OR julianday('now') - julianday(cp.last_run_at) > ${RECRAWL_DAYS}
     ORDER BY
       CASE s.reliability
         WHEN 'none' THEN 0 WHEN 'structural' THEN 1
         WHEN 'reference' THEN 2 WHEN 'estimated' THEN 3 ELSE 4
       END,
       cp.last_run_at ASC NULLS FIRST, p.id
     LIMIT ${limit}`,
  );
}

// ── DB 저장 (crawl_progress도 업데이트하여 cron과 큐 공유) ──
const WEB_SOURCE_COLS = [
  "parking_lot_id", "source", "source_id", "title", "content",
  "source_url", "relevance_score",
];

function flushResults(
  pending: Array<{ lotId: string; sourceId: string; title: string; desc: string; url: string; score: number }>,
  completedLotIds: string[],
): void {
  if (pending.length === 0 && completedLotIds.length === 0) return;

  const stmts: string[] = [];

  // web_sources INSERT
  for (const r of pending) {
    stmts.push(buildInsert("web_sources", WEB_SOURCE_COLS, [
      r.lotId, "ddg_search", r.sourceId, r.title, r.desc, r.url, r.score,
    ]));
  }

  // crawl_progress UPDATE (cron과 큐 공유)
  for (const lotId of completedLotIds) {
    stmts.push(
      `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
       VALUES ('ddg_lot:${lotId}', '${lotId}', 0, datetime('now'))
       ON CONFLICT(crawler_id) DO UPDATE SET last_run_at = datetime('now');`,
    );
  }

  flushStatements(TMP_SQL, stmts);
}

// ── Main ──
async function main() {
  console.log(`\n🦆 DuckDuckGo 크롤러 (${isRemote ? "remote" : "local"} DB, limit=${LIMIT}${isDryRun ? ", dry-run" : ""})`);
  console.log(`   crawl4ai: ${CRAWL4AI_URL}\n`);

  // health check
  try {
    const health = await fetch(`${CRAWL4AI_URL}/health`, { signal: AbortSignal.timeout(5000) });
    const data = (await health.json()) as { status: string; version: string };
    console.log(`   ✅ crawl4ai ${data.version} (${data.status})\n`);
  } catch {
    console.error("   ❌ crawl4ai 서버에 연결할 수 없습니다.\n");
    process.exit(1);
  }

  const progress = loadProgress<Progress>(PROGRESS_JSON, {
    completedIds: [],
    totalQueries: 0,
    savedSources: 0,
    skippedGeneric: 0,
    skippedLowRelevance: 0,
    startedAt: "",
    lastUpdatedAt: "",
  });

  const lots = selectPriorityLots(LIMIT);
  console.log(`  선택된 주차장: ${lots.length}개 (reliability 낮은 순)\n`);

  if (lots.length === 0) {
    console.log("  처리할 주차장이 없습니다 (모두 크롤링 완료).\n");
    return;
  }

  let consecutiveFailures = 0;
  let pending: Array<{ lotId: string; sourceId: string; title: string; desc: string; url: string; score: number }> = [];
  const completedBatch: string[] = [];

  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i];

    if (isGenericName(lot.name)) {
      progress.skippedGeneric++;
      completedBatch.push(lot.id);
      continue;
    }

    const region = extractRegion(lot.address);
    const query = `"${lot.name}" ${region} 주차 후기`.trim();

    process.stdout.write(`  [${i + 1}/${lots.length}] ${lot.name} (${lot.reliability ?? "none"}) `);

    try {
      const items = await searchDuckDuckGo(query);
      consecutiveFailures = 0;
      progress.totalQueries++;

      let lotSaved = 0;
      for (const item of items) {
        const score = scoreBlogRelevance(item.title, item.description, lot.name, lot.address);
        if (score < RELEVANCE_THRESHOLD) {
          progress.skippedLowRelevance++;
          continue;
        }

        const sourceId = await hashUrl(item.url);
        lotSaved++;

        if (isDryRun) {
          console.log(`\n      ✅ [${score}점] ${item.title.slice(0, 60)}`);
          console.log(`         ${item.url.slice(0, 80)}`);
        } else {
          pending.push({
            lotId: lot.id,
            sourceId,
            title: item.title,
            desc: item.description,
            url: item.url,
            score,
          });
        }
      }

      progress.savedSources += lotSaved;
      completedBatch.push(lot.id);

      if (!isDryRun) {
        process.stdout.write(`→ ${items.length}건 중 ${lotSaved}건 저장\n`);
      } else if (lotSaved === 0) {
        process.stdout.write(`→ ${items.length}건, 관련도 미달\n`);
      } else {
        process.stdout.write(`→ ${lotSaved}건 매칭\n`);
      }
    } catch (err) {
      consecutiveFailures++;
      console.log(`❌ ${(err as Error).message} (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES})`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error(`\n  ⛔ 연속 ${MAX_CONSECUTIVE_FAILURES}회 실패, 중단합니다.`);
        break;
      }
    }

    // DB flush
    if (!isDryRun && (pending.length >= DB_FLUSH_SIZE || i === lots.length - 1)) {
      flushResults(pending, completedBatch);
      pending = [];
      completedBatch.length = 0;
    }

    // progress 저장 (중단/재개용 — 로컬 JSON)
    if ((i + 1) % 10 === 0) {
      saveProgress(PROGRESS_JSON, progress);
    }

    await new Promise((r) => setTimeout(r, DELAY));
  }

  // 남은 것 flush
  if (!isDryRun && (pending.length > 0 || completedBatch.length > 0)) {
    flushResults(pending, completedBatch);
  }

  saveProgress(PROGRESS_JSON, progress);

  console.log(`\n📊 결과 요약`);
  console.log(`  처리: ${lots.length}개 주차장`);
  console.log(`  검색: ${progress.totalQueries}회`);
  console.log(`  저장: ${progress.savedSources}건 (threshold ≥ ${RELEVANCE_THRESHOLD})`);
  console.log(`  스킵: 제네릭=${progress.skippedGeneric} 저관련도=${progress.skippedLowRelevance}`);
  if (isDryRun) console.log(`  ⚠️  dry-run 모드 — DB 저장하지 않았습니다.`);
  console.log();
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
