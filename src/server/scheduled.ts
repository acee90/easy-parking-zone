/**
 * Cloudflare Workers Scheduled (Cron) 핸들러
 *
 * wrangler.jsonc의 triggers.crons에 등록된 스케줄로 자동 실행.
 * API 기반 크롤러(naver-blogs, youtube, brave-search)를 배치 실행.
 */
import { runNaverBlogsBatch } from "./crawlers/naver-blogs";
import { runYoutubeBatch } from "./crawlers/youtube";
import { runBraveSearchBatch } from "./crawlers/brave-search";

interface Env {
  DB: D1Database;
  NAVER_CLIENT_ID: string;
  NAVER_CLIENT_SECRET: string;
  YOUTUBE_API_KEY: string;
  BRAVE_SEARCH_API_KEY: string;
}

export async function handleScheduled(env: Env): Promise<void> {
  const results: string[] = [];

  // 네이버 블로그/카페 크롤링 (25,000/일, BATCH_SIZE=200)
  if (env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET) {
    try {
      const r = await runNaverBlogsBatch(env.DB, {
        NAVER_CLIENT_ID: env.NAVER_CLIENT_ID,
        NAVER_CLIENT_SECRET: env.NAVER_CLIENT_SECRET,
      });
      results.push(`naver: ${r.processed} lots, ${r.saved} saved, ${r.matched} multi-matched${r.done ? " (complete)" : ""}`);
    } catch (err) {
      results.push(`naver-blogs: error - ${(err as Error).message}`);
    }
  }

  // YouTube 크롤링
  if (env.YOUTUBE_API_KEY) {
    try {
      const r = await runYoutubeBatch(env.DB, {
        YOUTUBE_API_KEY: env.YOUTUBE_API_KEY,
      });
      results.push(`youtube: ${r.processed} lots, ${r.savedMedia} media, ${r.savedComments} comments${r.done ? " (complete)" : ""}`);
    } catch (err) {
      results.push(`youtube: error - ${(err as Error).message}`);
    }
  }

  // Brave Search 크롤링 (2,000/월, ~66/일)
  if (env.BRAVE_SEARCH_API_KEY) {
    try {
      const r = await runBraveSearchBatch(env.DB, {
        BRAVE_SEARCH_API_KEY: env.BRAVE_SEARCH_API_KEY,
      });
      results.push(`brave-search: ${r.queriesUsed} queries, ${r.saved} saved${r.done ? " (complete)" : ""}`);
    } catch (err) {
      results.push(`brave-search: error - ${(err as Error).message}`);
    }
  }

  console.log(`[scheduled] ${new Date().toISOString()} | ${results.join(" | ")}`);
}
