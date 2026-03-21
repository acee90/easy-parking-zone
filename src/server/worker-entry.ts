/**
 * Custom Worker entry point
 *
 * TanStack Start의 fetch 핸들러를 그대로 사용하면서
 * Cloudflare Workers Cron용 scheduled 핸들러를 추가.
 */
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { handleScheduled } from "./scheduled";

interface Env {
  DB: D1Database;
  NAVER_CLIENT_ID: string;
  NAVER_CLIENT_SECRET: string;
  YOUTUBE_API_KEY: string;
  BRAVE_SEARCH_API_KEY: string;
}

const startHandler = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    // /__scheduled 경로로 수동 트리거 (dev/testing용)
    if (url.pathname === "/__scheduled") {
      await handleScheduled(env);
      return new Response("OK", { status: 200 });
    }

    // Sitemap: TanStack Start가 Content-Type을 text/html로 덮어쓰는 문제 우회
    // 서버 핸들러 응답을 프록시하여 올바른 Content-Type 보장
    if (url.pathname === "/sitemap.xml" || url.pathname === "/sitemap-static.xml" || url.pathname.startsWith("/sitemap/")) {
      const response = await startHandler(request, env);
      const body = await response.text();
      if (body.startsWith("<?xml")) {
        return new Response(body, {
          status: response.status,
          headers: {
            "Content-Type": "application/xml; charset=utf-8",
            "Cache-Control": "public, max-age=86400",
          },
        });
      }
      return response;
    }

    return startHandler(request, env);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
};
