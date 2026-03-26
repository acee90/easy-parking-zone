/**
 * Cloudflare Workers Scheduled (Cron) 핸들러
 *
 * 매시간 실행. 파이프라인:
 *   1. 크롤링 → web_sources_raw (URL 단위)
 *   2. AI 필터 → filter_passed 업데이트
 *   3. 주차장 매칭 → filter_passed=1 → web_sources (parking_lot_id 연결)
 *   4. 스코어링 재계산
 */
import { runNaverBlogsBatch } from "./crawlers/naver-blogs";
import { runYoutubeBatch } from "./crawlers/youtube";
import { runBraveSearchBatch } from "./crawlers/brave-search";
import { runDuckDuckGoBatch } from "./crawlers/duckduckgo-search";
import { runAiFilterBatch } from "./crawlers/ai-filter-batch";
import { runMatchBatch } from "./crawlers/match-to-lots";
import { recomputeStats } from "./crawlers/lib/scoring-engine";

interface Env {
  DB: D1Database;
  NAVER_CLIENT_ID: string;
  NAVER_CLIENT_SECRET: string;
  YOUTUBE_API_KEY: string;
  BRAVE_SEARCH_API_KEY: string;
  CRAWL4AI_URL: string;
  ANTHROPIC_API_KEY: string;
}

export async function handleScheduled(env: Env): Promise<void> {
  const results: string[] = [];

  // ── 1. 크롤링 → web_sources_raw ──

  if (env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET) {
    try {
      const r = await runNaverBlogsBatch(env.DB, {
        NAVER_CLIENT_ID: env.NAVER_CLIENT_ID,
        NAVER_CLIENT_SECRET: env.NAVER_CLIENT_SECRET,
      });
      results.push(`naver: ${r.processed} lots, ${r.saved} saved`);
    } catch (err) {
      results.push(`naver: error - ${(err as Error).message}`);
    }
  }

  if (env.YOUTUBE_API_KEY) {
    try {
      const r = await runYoutubeBatch(env.DB, {
        YOUTUBE_API_KEY: env.YOUTUBE_API_KEY,
      });
      results.push(`youtube: ${r.processed} lots, ${r.savedMedia} media, ${r.savedComments} comments`);
    } catch (err) {
      results.push(`youtube: error - ${(err as Error).message}`);
    }
  }

  if (env.BRAVE_SEARCH_API_KEY) {
    try {
      const r = await runBraveSearchBatch(env.DB, {
        BRAVE_SEARCH_API_KEY: env.BRAVE_SEARCH_API_KEY,
      });
      if (r.skipped) {
        results.push("brave: skipped (already ran today)");
      } else {
        results.push(`brave: ${r.queriesUsed} queries, ${r.saved} saved`);
      }
    } catch (err) {
      results.push(`brave: error - ${(err as Error).message}`);
    }
  }

  if (env.CRAWL4AI_URL) {
    try {
      const r = await runDuckDuckGoBatch(env.DB, {
        CRAWL4AI_URL: env.CRAWL4AI_URL,
      });
      results.push(`ddg: ${r.queriesUsed} queries, ${r.saved} saved`);
    } catch (err) {
      results.push(`ddg: error - ${(err as Error).message}`);
    }
  }

  // ── 2. AI 필터 (미분류 raw → Haiku 분류) ──

  if (env.ANTHROPIC_API_KEY) {
    try {
      const r = await runAiFilterBatch(env.DB, {
        ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY,
      });
      if (r.filtered > 0) {
        results.push(`ai-filter: ${r.filtered} processed, ${r.passed} passed, ${r.removed} removed`);
      }
    } catch (err) {
      results.push(`ai-filter: error - ${(err as Error).message}`);
    }
  }

  // ── 3. 주차장 매칭 (filter_passed=1 & 미매칭 → web_sources) ──

  try {
    const r = await runMatchBatch(env.DB, { ANTHROPIC_API_KEY: env.ANTHROPIC_API_KEY });
    if (r.matched > 0) {
      results.push(`match: ${r.matched} sources → ${r.lotLinks} lot links (${r.aiVerified} AI verified)`);
    }
  } catch (err) {
    results.push(`match: error - ${(err as Error).message}`);
  }

  // ── 4. 스코어링 재계산 (최근 2시간 내 매칭된 주차장, cron 지연 버퍼 포함) ──
  const changedRows = await env.DB
    .prepare(
      `SELECT DISTINCT ws.parking_lot_id
       FROM web_sources ws
       JOIN web_sources_raw r ON r.id = ws.raw_source_id
       WHERE r.matched_at > datetime('now', '-2 hours')`,
    )
    .all<{ parking_lot_id: string }>();

  const changedLotIds = (changedRows.results ?? []).map((r) => r.parking_lot_id);
  if (changedLotIds.length > 0) {
    try {
      const r = await recomputeStats(env.DB, changedLotIds);
      results.push(`scoring: ${r.updated} lots recomputed`);
    } catch (err) {
      results.push(`scoring: error - ${(err as Error).message}`);
    }
  }

  console.log(`[scheduled] ${new Date().toISOString()} | ${results.join(" | ")}`);
}
