/**
 * Custom Worker entry point
 *
 * TanStack Start의 fetch 핸들러를 그대로 사용하면서
 * Cloudflare Workers Cron용 scheduled 핸들러를 추가.
 */
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { handleScheduled, handleDdgScheduled } from "./scheduled";

interface Env {
  DB: D1Database;
  NAVER_CLIENT_ID: string;
  NAVER_CLIENT_SECRET: string;
  YOUTUBE_API_KEY: string;
  BRAVE_SEARCH_API_KEY: string;
  CRAWL4AI_URL: string;
  ANTHROPIC_API_KEY: string;
}

const startHandler = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // /__scheduled 경로로 수동 트리거 (dev/testing용)
    if (url.pathname === "/__scheduled" || url.pathname === "/__scheduled/ddg") {
      const isDdg = url.pathname.includes("ddg");
      const logs: string[] = [];
      const origLog = console.log;
      console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); origLog(...args); };
      try {
        if (isDdg) await handleDdgScheduled(env);
        else await handleScheduled(env);
      } catch (err) {
        logs.push(`FATAL: ${(err as Error).message}`);
      }
      console.log = origLog;
      return new Response(JSON.stringify({ ok: true, logs }, null, 2), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Sitemap: TanStack Start 서버 핸들러가 Content-Type을 text/html로 덮어쓰거나
    // 동적 라우트($id)가 404를 반환하는 문제 우회 — worker-entry에서 직접 처리
    if (url.pathname.match(/^\/sitemap(-\w+)?\.xml$/) || url.pathname.startsWith("/sitemap/")) {
      const { handleSitemap } = await import("./sitemap-handler");
      return handleSitemap(url.pathname, env.DB);
    }

    return startHandler(request, env);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    // 매시 0분: 메인 파이프라인 (naver, youtube, brave, AI필터, 매칭, 스코어링)
    // 매시 30분: DDG 크롤링 (별도 subrequest 한도)
    if (controller.cron === "30 */1 * * *") {
      ctx.waitUntil(handleDdgScheduled(env));
    } else {
      ctx.waitUntil(handleScheduled(env));
    }
  },
};
