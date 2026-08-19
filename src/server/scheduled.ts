/**
 * Cloudflare Workers Scheduled (Cron) 핸들러
 *
 * 매시간 실행. 파이프라인 (#149 fulltext-first):
 *   1. 크롤링 → web_sources_raw (URL 단위, full_text_status='pending')
 *   2. raw fulltext batch → web_sources_raw.full_text 채움
 *   3. AI 필터 → rule(high/low 즉시) + Haiku(medium만), fulltext 입력
 *   4. 주차장 매칭 → filter_passed=1 → web_sources (정제 데이터만; full_text는 raw 유지, raw_source_id JOIN)
 *   5. 스코어링 재계산
 *
 * DDG cron (매시 30분):
 *   1. DDG 크롤링
 *   2. raw fulltext batch (DDG raw rows)
 */

import { runAiFilterBatch } from './crawlers/ai-filter-batch'
import { runBraveSearchBatch } from './crawlers/brave-search'
import { runDuckDuckGoBatch } from './crawlers/duckduckgo-search'
import { syncQueue } from './crawlers/lib/crawl-queue'
import { recomputeStats } from './crawlers/lib/scoring-engine'
import { runMatchBatch } from './crawlers/match-to-lots'
import { runNaverBlogsBatch } from './crawlers/naver-blogs'
import { runRawFullTextBatch } from './crawlers/raw-fulltext-batch'
import { runYoutubeBatch } from './crawlers/youtube'

interface Env {
  DB: D1Database
  NAVER_CLIENT_ID: string
  NAVER_CLIENT_SECRET: string
  YOUTUBE_API_KEY: string
  BRAVE_SEARCH_API_KEY: string
  CRAWL4AI_URL: string
  UNSLOTH_API_KEY: string
  AI_MODEL?: string
  AI_BASE_URL?: string
}

export async function handleScheduled(env: Env): Promise<void> {
  const results: string[] = []

  // ── 1. 크롤링 → web_sources_raw ──

  if (env.NAVER_CLIENT_ID && env.NAVER_CLIENT_SECRET) {
    try {
      const r = await runNaverBlogsBatch(env.DB, {
        NAVER_CLIENT_ID: env.NAVER_CLIENT_ID,
        NAVER_CLIENT_SECRET: env.NAVER_CLIENT_SECRET,
      })
      results.push(`naver: ${r.processed} lots, ${r.saved} saved`)
    } catch (err) {
      results.push(`naver: error - ${(err as Error).message}`)
    }
  }

  if (env.YOUTUBE_API_KEY) {
    try {
      const r = await runYoutubeBatch(env.DB, {
        YOUTUBE_API_KEY: env.YOUTUBE_API_KEY,
      })
      results.push(
        `youtube: ${r.processed} lots, ${r.savedMedia} media, ${r.savedComments} comments`,
      )
    } catch (err) {
      results.push(`youtube: error - ${(err as Error).message}`)
    }
  }

  if (env.BRAVE_SEARCH_API_KEY) {
    try {
      const r = await runBraveSearchBatch(env.DB, {
        BRAVE_SEARCH_API_KEY: env.BRAVE_SEARCH_API_KEY,
      })
      if (r.skipped) {
        results.push('brave: skipped (already ran today)')
      } else {
        results.push(`brave: ${r.queriesUsed} queries, ${r.saved} saved`)
      }
    } catch (err) {
      results.push(`brave: error - ${(err as Error).message}`)
    }
  }

  // DDG는 별도 cron (매시 30분) — subrequest 한도 분리

  // ── 2. raw fulltext batch (pending raw rows → crawl4ai) ──

  if (env.CRAWL4AI_URL) {
    try {
      const r = await runRawFullTextBatch(env.DB, { CRAWL4AI_URL: env.CRAWL4AI_URL })
      if (r.processed > 0) {
        results.push(`raw-fulltext: ${r.processed} processed, ${r.ok} ok, ${r.skipped} skipped`)
      }
    } catch (err) {
      results.push(`raw-fulltext: error - ${(err as Error).message}`)
    }
  }

  // ── 3. rule 필터 (full_text_status='ok' & 미분류 → high/low 즉시 판정, medium은 match로) ──

  if (env.UNSLOTH_API_KEY) {
    try {
      const r = await runAiFilterBatch(env.DB, {
        UNSLOTH_API_KEY: env.UNSLOTH_API_KEY,
      })
      if (r.filtered > 0) {
        results.push(`ai-filter: ${r.filtered} processed, ${r.passed} passed, ${r.removed} removed`)
      }
    } catch (err) {
      results.push(`ai-filter: error - ${(err as Error).message}`)
    }
  }

  // ── 4. 주차장 매칭 + post-match AI 품질 판정 (filter_passed=1 & 미매칭 → web_sources) ──

  try {
    const r = await runMatchBatch(env.DB, {
      UNSLOTH_API_KEY: env.UNSLOTH_API_KEY,
      AI_MODEL: env.AI_MODEL,
      AI_BASE_URL: env.AI_BASE_URL,
    })
    if (r.matched > 0) {
      results.push(
        `match: ${r.matched} sources → ${r.lotLinks} lot links (${r.aiVerified} AI verified)`,
      )
    }
  } catch (err) {
    results.push(`match: error - ${(err as Error).message}`)
  }

  // ── 5. 스코어링 재계산 (crawl_progress 기반 — last_run_at 이후 매칭 건) ──
  const scoringProgress = await env.DB.prepare(
    "SELECT last_run_at FROM crawl_progress WHERE crawler_id = 'scoring'",
  ).first<{ last_run_at: string | null }>()

  const lastScoringRun = scoringProgress?.last_run_at ?? '2000-01-01'

  // web_sources.matched_at을 직접 본다 (0049). 과거에는 web_sources_raw를 JOIN했는데,
  // raw는 처리 완료 후 삭제되는 임시 데이터라 JOIN이 조용히 0건이 된다.
  const changedRows = await env.DB.prepare(
    `SELECT DISTINCT ws.parking_lot_id
       FROM web_sources ws
       WHERE ws.matched_at > ?1`,
  )
    .bind(lastScoringRun)
    .all<{ parking_lot_id: string }>()

  const changedLotIds = (changedRows.results ?? []).map((r) => r.parking_lot_id)
  if (changedLotIds.length > 0) {
    try {
      const r = await recomputeStats(env.DB, changedLotIds)
      results.push(`scoring: ${r.updated} lots recomputed`)
    } catch (err) {
      results.push(`scoring: error - ${(err as Error).message}`)
    }
  }

  // crawl_progress에 scoring 실행 기록
  await env.DB.prepare(
    `INSERT INTO crawl_progress (crawler_id, last_run_at, completed_count)
       VALUES ('scoring', datetime('now'), ?1)
       ON CONFLICT(crawler_id) DO UPDATE SET
         last_run_at = datetime('now'),
         completed_count = completed_count + ?1`,
  )
    .bind(changedLotIds.length)
    .run()

  // ── 5.5 crawl_queue 동기화 (하루 1회) ──
  //
  // 신규 주차장을 큐에 넣고, 스코어링으로 바뀐 reliability 를 priority 에 반영한다.
  // 전 주차장을 훑으므로 비싸다 — 매 사이클 돌리면 crawl_queue 가 없애려던 비용이 그대로
  // 돌아온다. crawl_progress 의 'crawl_queue_sync' 레코드로 하루 1회만 실행되게 막는다.
  try {
    const lastSync = await env.DB.prepare(
      "SELECT last_run_at FROM crawl_progress WHERE crawler_id = 'crawl_queue_sync'",
    ).first<{ last_run_at: string | null }>()
    const today = new Date().toISOString().slice(0, 10)
    if (lastSync?.last_run_at?.slice(0, 10) !== today) {
      const r = await syncQueue(env.DB)
      await env.DB.prepare(
        `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
           VALUES ('crawl_queue_sync', '', 0, datetime('now'))
           ON CONFLICT(crawler_id) DO UPDATE SET last_run_at = datetime('now')`,
      ).run()
      results.push(`queue-sync: +${r.inserted} new, ${r.repriced} repriced`)
    }
  } catch (err) {
    results.push(`queue-sync: error - ${(err as Error).message}`)
  }

  // ── 6. 본문 purge (terminal 행만) ──
  //
  // 처리가 끝난 raw의 본문은 더 이상 필요 없다. 이 단계가 없으면 본문이 무한 누적된다
  // (2026-08 실측: 하루 약 60MB, 6일간 1.18GB→1.54GB).
  //
  // ⚠️ 조건을 `ai_filtered_at IS NOT NULL`로 바꾸지 말 것.
  //    ai_filtered_at은 AI가 아니라 rule filter가 설정하고, lot-match가 아직 본문을
  //    필요로 하므로 매칭 대기 행의 본문까지 지워 영구 zombie가 된다 (2026-06-09 사고).
  //    본문이 정말 불필요해지는 시점은 rule 탈락(filter_passed=0) 또는 매칭 완료(matched_at)다.
  try {
    const purge = await env.DB.prepare(
      `DELETE FROM web_sources_raw_body
       WHERE raw_id IN (
         SELECT id FROM web_sources_raw
         WHERE full_text_status = 'ok'
           AND (filter_passed = 0 OR matched_at IS NOT NULL)
       )`,
    ).run()

    const purged = purge.meta?.changes ?? 0
    if (purged > 0) {
      await env.DB.prepare(
        `UPDATE web_sources_raw SET full_text_status = 'purged'
         WHERE full_text_status = 'ok'
           AND (filter_passed = 0 OR matched_at IS NOT NULL)`,
      ).run()
      results.push(`purge: ${purged} bodies`)
    }
  } catch (err) {
    results.push(`purge: error - ${(err as Error).message}`)
  }

  console.log(`[scheduled] ${new Date().toISOString()} | ${results.join(' | ')}`)
}

/**
 * DDG 전용 cron (매시 30분)
 * subrequest 한도를 메인 파이프라인과 분리.
 */
export async function handleDdgScheduled(env: Env): Promise<void> {
  const results: string[] = []

  if (env.CRAWL4AI_URL) {
    try {
      const r = await runDuckDuckGoBatch(env.DB, {
        CRAWL4AI_URL: env.CRAWL4AI_URL,
      })
      results.push(`ddg: ${r.queriesUsed} queries, ${r.saved} saved`)
    } catch (err) {
      results.push(`ddg: error - ${(err as Error).message}`)
    }

    try {
      const r = await runRawFullTextBatch(env.DB, { CRAWL4AI_URL: env.CRAWL4AI_URL })
      if (r.processed > 0) {
        results.push(`raw-fulltext: ${r.processed} processed, ${r.ok} ok, ${r.skipped} skipped`)
      }
    } catch (err) {
      results.push(`raw-fulltext: error - ${(err as Error).message}`)
    }
  }

  console.log(`[scheduled-ddg] ${new Date().toISOString()} | ${results.join(' | ')}`)
}
