/**
 * Cloudflare Workers Scheduled (Cron) 핸들러
 *
 * 매시간 실행. 파이프라인: 크롤링 → 스코어링 재계산
 *
 * 1. 네이버 블로그/카페 크롤링 (BATCH_SIZE=25)
 * 2. YouTube 크롤링
 * 3. Brave Search 크롤링 (하루 1회)
 * 4. 변경된 주차장 incremental 스코어링 재계산
 */
import { runNaverBlogsBatch } from "./crawlers/naver-blogs";
import { runYoutubeBatch } from "./crawlers/youtube";
import { runBraveSearchBatch } from "./crawlers/brave-search";
import { runDuckDuckGoBatch } from "./crawlers/duckduckgo-search";
import { recomputeStats } from "./crawlers/lib/scoring-engine";

interface Env {
  DB: D1Database;
  NAVER_CLIENT_ID: string;
  NAVER_CLIENT_SECRET: string;
  YOUTUBE_API_KEY: string;
  BRAVE_SEARCH_API_KEY: string;
  CRAWL4AI_URL: string;
}

export async function handleScheduled(env: Env): Promise<void> {
  const results: string[] = [];
  const changedLotIds = new Set<string>();

  // ── 1. 크롤링 ──

  // 네이버 블로그/카페 (25,000/일, BATCH_SIZE=25)
  if (env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET) {
    try {
      const r = await runNaverBlogsBatch(env.DB, {
        NAVER_CLIENT_ID: env.NAVER_CLIENT_ID,
        NAVER_CLIENT_SECRET: env.NAVER_CLIENT_SECRET,
      });
      results.push(`naver: ${r.processed} lots, ${r.saved} saved, ${r.matched} multi-matched`);
      for (const id of r.changedLotIds) changedLotIds.add(id);
    } catch (err) {
      results.push(`naver: error - ${(err as Error).message}`);
    }
  }

  // YouTube
  if (env.YOUTUBE_API_KEY) {
    try {
      const r = await runYoutubeBatch(env.DB, {
        YOUTUBE_API_KEY: env.YOUTUBE_API_KEY,
      });
      results.push(`youtube: ${r.processed} lots, ${r.savedMedia} media, ${r.savedComments} comments`);
      // YouTube 크롤러는 changedLotIds 미지원 → 별도 처리 불필요 (빈도 낮음)
    } catch (err) {
      results.push(`youtube: error - ${(err as Error).message}`);
    }
  }

  // Brave Search (하루 1회, 2,000/월)
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

  // DuckDuckGo Search via crawl4ai (API 키 불필요)
  if (env.CRAWL4AI_URL) {
    try {
      const r = await runDuckDuckGoBatch(env.DB, {
        CRAWL4AI_URL: env.CRAWL4AI_URL,
      });
      if (r.skipped) {
        results.push("ddg: skipped (already ran today)");
      } else {
        results.push(`ddg: ${r.queriesUsed} queries, ${r.saved} saved`);
        for (const id of r.changedLotIds) changedLotIds.add(id);
      }
    } catch (err) {
      results.push(`ddg: error - ${(err as Error).message}`);
    }
  }

  // ── 2. Incremental 스코어링 재계산 ──

  if (changedLotIds.size > 0) {
    try {
      const r = await recomputeStats(env.DB, [...changedLotIds]);
      results.push(`scoring: ${r.updated} lots recomputed`);
    } catch (err) {
      results.push(`scoring: error - ${(err as Error).message}`);
    }
  }

  console.log(`[scheduled] ${new Date().toISOString()} | ${results.join(" | ")}`);
}
