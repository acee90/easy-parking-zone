/**
 * Cloudflare Workers Scheduled (Cron) 핸들러
 *
 * 매시간 실행. 파이프라인 (#149 fulltext-first):
 *   1. 크롤링 → web_sources_raw (URL 단위, full_text_status='pending')
 *   2. raw fulltext batch → web_sources_raw.full_text 채움
 *   3. 필터 대상 선정 → source-filter-queue (판정은 소비자가 배치 100으로)
 *   4. 주차장 매칭 → filter_passed=1 → web_sources (정제 데이터만; full_text는 raw 유지, raw_source_id JOIN)
 *   5. 스코어링 재계산 (큐가 없을 때만 — 평소엔 score-recompute-queue 담당)
 *
 * 종합 요약 cron (매시 45분):
 *   ai_summary_stale=1 인 주차장의 parking_lot_stats.ai_summary 생성
 *
 * DDG cron (매시 30분):
 *   1. DDG 크롤링
 *   2. raw fulltext batch (DDG raw rows)
 */

import { runAiFilterBatch } from './crawlers/ai-filter-batch'
import { runBraveSearchBatch } from './crawlers/brave-search'
import { runDuckDuckGoBatch } from './crawlers/duckduckgo-search'
import { syncQueue } from './crawlers/lib/crawl-queue'
import { RAW_DELETE_LIMIT_PER_RUN, TERMINAL_RAW_CONDITION } from './crawlers/lib/raw-retention'
import { recomputeStats } from './crawlers/lib/scoring-engine'
import { runLotSummaryBatch } from './crawlers/lot-summary-batch'
import { runMatchBatch } from './crawlers/match-to-lots'
import { runNaverBlogsBatch } from './crawlers/naver-blogs'
import { runRawFullTextBatch } from './crawlers/raw-fulltext-batch'
import { runYoutubeBatch } from './crawlers/youtube'
import { enqueueScoreRecomputeBatch } from './queues/score-recompute'

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

  // ── 3. rule 필터 대상 선정 → source-filter-queue ──
  //
  // 여기서는 id 만 골라 넘긴다. 판정은 소비자가 배치 100으로 한다.
  // 예전처럼 크론 안에서 직접 돌리면 회당 100건에 묶여 백로그가 자란다.
  try {
    const r = await runAiFilterBatch(env.DB)
    if (r.enqueued > 0) {
      results.push(`filter-enqueue: ${r.enqueued} raws → queue`)
    } else if (r.filtered > 0) {
      results.push(
        `ai-filter: ${r.filtered} processed inline, ${r.passed} passed, ${r.removed} removed (queue 없음)`,
      )
    }
  } catch (err) {
    results.push(`filter-enqueue: error - ${(err as Error).message}`)
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
        `match: ${r.matched} sources → ${r.lotLinks} lot links (${r.aiVerified} AI verified, ${r.summarized} summarized)`,
      )
    }
    // 시간 예산에 걸려 중단됐다는 뜻이다. 남은 raw 는 다음 회차가 이어받지만,
    // 이게 계속 찍히면 처리량이 유입을 못 따라가고 있다는 신호다.
    if (r.budgetExceeded) results.push('match: AI budget exceeded (다음 회차 이어받음)')
  } catch (err) {
    results.push(`match: error - ${(err as Error).message}`)
  }

  // ── 5. 스코어링 보정 (crawl_progress 기반 — last_run_at 이후 매칭 건) ──
  //
  // 평상시엔 큐(score-recompute-queue)가 매칭 직후에 lot 단위로 이미 재계산한다.
  // 그런데 큐로 안 들어가는 경로가 둘 있다.
  //   (a) 매칭 루프가 시간 예산에 걸려 중간에 끊긴 경우 — 행은 flush 로 이미 들어갔는데
  //       enqueue 는 루프가 끝나야 돈다
  //   (b) sendBatch 자체가 실패한 경우 — 삼키고 로그만 남긴다
  // 그래서 이 단계는 **재계산이 아니라 재투입**을 한다. 여기서 직접 계산하면 큐가 이미
  // 한 일을 한 번 더 하게 되고, rows_read 를 줄이려고 크론 주기까지 늘린 게 무의미해진다.
  //
  // `matched_at > computed_at` 조건이 핵심이다 — 큐가 이미 처리한 lot 은 computed_at 이
  // 앞서 있어 걸리지 않는다. 즉 정상 경로에서는 0건이고, 빠진 것만 잡힌다.
  const scoringProgress = await env.DB.prepare(
    "SELECT last_run_at FROM crawl_progress WHERE crawler_id = 'scoring'",
  ).first<{ last_run_at: string | null }>()

  const lastScoringRun = scoringProgress?.last_run_at ?? '2000-01-01'

  // web_sources.matched_at을 직접 본다 (0049). 과거에는 web_sources_raw를 JOIN했는데,
  // raw는 처리 완료 후 삭제되는 임시 데이터라 JOIN이 조용히 0건이 된다.
  const changedRows = await env.DB.prepare(
    `SELECT DISTINCT ws.parking_lot_id
       FROM web_sources ws
       LEFT JOIN parking_lot_stats s ON s.parking_lot_id = ws.parking_lot_id
       WHERE ws.matched_at > ?1
         AND (s.computed_at IS NULL OR ws.matched_at > s.computed_at)`,
  )
    .bind(lastScoringRun)
    .all<{ parking_lot_id: string }>()

  const changedLotIds = (changedRows.results ?? []).map((r) => r.parking_lot_id)
  if (changedLotIds.length > 0) {
    try {
      const enq = await enqueueScoreRecomputeBatch(
        changedLotIds.map((lotId) => ({ lotId, reason: 'web_source_matched' as const })),
      )
      if (enq.enqueued > 0) {
        results.push(`scoring: ${enq.enqueued} lots re-enqueued (큐에서 누락된 분)`)
      } else {
        // 큐가 아예 없는 환경(바인딩 누락)에서는 직접 계산한다.
        const r = await recomputeStats(env.DB, changedLotIds)
        results.push(`scoring: ${r.updated} lots recomputed (queue 없음, 폴백)`)
      }
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

  // ── 6. 종결 raw 삭제 (본문 + 원장) ──
  //
  // 이 단계는 원래 **본문만** 지웠다. 원장 행은 `full_text_status='purged'` 로 표시만
  // 하고 남겨 두었는데, 지우는 코드가 어디에도 없어 영구 누적됐다
  // (2026-09-04 실측: 152,085행 중 150,336행이 종결 상태로 잔류, 하루 1,600~2,300행 증가).
  //
  // 원장까지 지워도 되는 근거는 마이그레이션 0049·0050·0051 이 이미 깔아 뒀다.
  // 특히 재크롤: 중복 판정은 `seen_sources` 가 하고, 크롤러 4종이 삽입 전에 그걸 조회한다
  // (2026-09-04 실측: raw 152,085행 전부 seen_sources 에 존재, 누락 0건).
  //
  // 순서가 중요하다. **본문을 먼저 지운다** — 원장을 먼저 지우면 본문 행이 고아가 되어
  // JOIN 으로는 다시 찾을 수 없다.
  //
  // 종결의 정의는 `raw-retention.ts` 가 갖는다. 조건을 여기서 고치지 말 것.
  try {
    const deletedBodies = await env.DB.prepare(
      `DELETE FROM web_sources_raw_body
       WHERE raw_id IN (
         SELECT b.raw_id
           FROM web_sources_raw_body b
           JOIN web_sources_raw r ON r.id = b.raw_id
          WHERE ${TERMINAL_RAW_CONDITION}
       )`,
    ).run()

    // 원장은 상한을 둔다. 백로그(15만 행)는 scripts/cleanup-terminal-raw.ts 가 맡고,
    // 여기서는 정상 유입분만 따라가면 된다.
    const deletedRows = await env.DB.prepare(
      `DELETE FROM web_sources_raw
        WHERE id IN (
          SELECT r.id FROM web_sources_raw r
           WHERE ${TERMINAL_RAW_CONDITION}
           ORDER BY r.id
           LIMIT ?1
        )`,
    )
      .bind(RAW_DELETE_LIMIT_PER_RUN)
      .run()

    const bodies = deletedBodies.meta?.changes ?? 0
    const rows = deletedRows.meta?.changes ?? 0
    if (bodies > 0 || rows > 0) {
      results.push(`purge: ${bodies} bodies, ${rows} raw rows`)
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

/**
 * 종합 요약 전용 cron
 *
 * 메인 파이프라인에 붙이지 않은 이유는 wall time 이다. 메인은 이미 크롤·본문·필터·매칭을
 * 한 호출에 담고 있고, 매칭 단계만으로 AI 호출이 수십 건이다. 여기에 요약 호출을 더하면
 * 15분 한도를 넘긴다. subrequest 한도(1,000/invocation)도 따로 쓴다.
 */
export async function handleLotSummaryScheduled(env: Env): Promise<void> {
  const results: string[] = []
  try {
    const r = await runLotSummaryBatch(env.DB, {
      UNSLOTH_API_KEY: env.UNSLOTH_API_KEY,
      AI_MODEL: env.AI_MODEL,
      AI_BASE_URL: env.AI_BASE_URL,
    })
    if (r.picked > 0) {
      results.push(
        `lot-summary: ${r.generated}/${r.picked} generated (no-input ${r.noInput}, rejected ${r.rejected}, failed ${r.failed})`,
      )
    }
    if (r.budgetExceeded) results.push('lot-summary: budget exceeded')
  } catch (err) {
    results.push(`lot-summary: error - ${(err as Error).message}`)
  }

  if (results.length > 0) {
    console.log(`[scheduled:lot-summary] ${new Date().toISOString()} | ${results.join(' | ')}`)
  }
}
