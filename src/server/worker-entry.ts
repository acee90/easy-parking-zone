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
}

const startHandler = createStartHandler(defaultStreamHandler);

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // /__scheduled 경로로 수동 트리거 (dev/testing용)
    const url = new URL(request.url);
    if (url.pathname === "/__scheduled") {
      await handleScheduled(env);
      return new Response("OK", { status: 200 });
    }
    return startHandler(request, env, ctx);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
};
