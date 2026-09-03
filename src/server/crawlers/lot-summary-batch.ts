/**
 * 주차장 종합 요약 생성 배치 (Workers Cron용)
 *
 * 층 구분:
 *   글 요약  web_sources.ai_summary        ← 매칭 시점 (match-to-lots.ts)
 *   종합 요약 parking_lot_stats.ai_summary  ← 이 파일
 *
 * 주차장 하나의 근거는 한꺼번에 쌓이지 않는다. 그래서 "글이 하나 붙을 때마다 다시 쓴다"가
 * 아니라, 큐 소비자가 `ai_summary_stale = 1` 로 표시해 두고 여기서 몰아서 만든다.
 * 표시 기준은 `queues/score-recompute.ts` 가 정한다.
 *
 * ⚠️ 회당 상한(`MAX_PER_RUN`)을 올리지 말 것.
 *    건당 AI 호출이 최대 120초라 상한이 곧 wall time 이다. 크론 한도는 15분이다.
 *    대량 backfill 은 이 경로가 아니라 `scripts/generate-lot-summary.ts` 로 한다.
 */

import { callAiText, parseAiJson } from './lib/ai-client'
import { webQuotaFor } from './lib/lot-summary-input'
import {
  buildLotSummaryUserPrompt,
  LOT_SUMMARY_SYSTEM_PROMPT,
  type LotSummaryResult,
  type LotSummaryReviewRow,
  type LotSummaryWebRow,
  MIN_LOT_SUMMARY_LENGTH,
} from './lib/lot-summary-prompt'
import { detectSummaryPollution } from './lib/summary-guard'

/** 회당 처리할 주차장 수 */
const MAX_PER_RUN = 6

/** AI 호출에 쓸 시간 예산 (크론 wall 15분 중) */
const AI_BUDGET_MS = 10 * 60 * 1000

/** 근거로 쓸 만한 글의 최소 관련도 — 낮은 건 다른 주차장 얘기가 섞여 있다 */
const MIN_RELEVANCE = 40

/** 이용자 리뷰 상한 */
const REVIEW_LIMIT = 20
/** 시드 리뷰 상한 */
const SEED_REVIEW_LIMIT = 10

interface StaleLotRow {
  id: string
  name: string
  address: string
}

export interface LotSummaryBatchResult {
  picked: number
  generated: number
  /** 근거가 없어 만들 수 없었던 곳 (표시는 내린다 — 다시 골라봐야 같다) */
  noInput: number
  /** 품질 가드에 걸려 저장하지 않은 곳 */
  rejected: number
  /** 일시적 실패 — 표시를 남겨 다음 회차가 다시 시도한다 */
  failed: number
  budgetExceeded: boolean
}

export async function runLotSummaryBatch(
  db: D1Database,
  env: { UNSLOTH_API_KEY?: string; AI_MODEL?: string; AI_BASE_URL?: string },
): Promise<LotSummaryBatchResult> {
  const result: LotSummaryBatchResult = {
    picked: 0,
    generated: 0,
    noInput: 0,
    rejected: 0,
    failed: 0,
    budgetExceeded: false,
  }
  if (!env.UNSLOTH_API_KEY) return result

  const lots = await pickStaleLots(db)
  result.picked = lots.length
  if (lots.length === 0) return result

  const deadline = Date.now() + AI_BUDGET_MS

  for (const lot of lots) {
    if (Date.now() >= deadline) {
      result.budgetExceeded = true
      break
    }

    const inputs = await fetchLotInputs(db, lot.id)

    // 웹 근거도 이용자 후기도 없으면 쓸 게 없다.
    // 다시 골라도 결과가 같으므로 표시를 내린다 — 안 그러면 매 회차 상한 한 칸을 먹는다.
    if (inputs.web.length === 0 && inputs.reviews.length === 0 && inputs.seedReviews.length === 0) {
      await clearStale(db, lot.id)
      result.noInput++
      continue
    }

    let generated: LotSummaryResult | null
    try {
      generated = await generateLotSummary(lot, inputs, env)
    } catch (err) {
      // 일시적 실패(타임아웃·5xx)만 여기로 온다. 표시를 남겨 다음 회차가 다시 시도한다.
      console.log(`[lot-summary] error lot=${lot.id}: ${(err as Error).message}`)
      result.failed++
      continue
    }

    if (!generated) {
      // 응답은 왔는데 사양을 못 지켰다. 같은 입력이면 또 같을 테니 표시를 내린다.
      await clearStale(db, lot.id)
      result.rejected++
      continue
    }

    await saveSummary(db, lot.id, generated)
    result.generated++
  }

  return result
}

/**
 * 대상 선정.
 *
 * 실사용자 리뷰가 있는 곳을 먼저 고른다 — 우리 신뢰 등급에서 1순위 근거이고,
 * 그런 곳이 87곳뿐이라 뒤로 밀리면 영영 순서가 안 온다.
 * 그다음은 근거가 많은 순이다.
 *
 * ⚠️ `s.review_count` 로 판정하지 않는다. 그 값은 **시드 리뷰를 포함**해서,
 *    2026-09-03 실측으로 147곳이 걸리지만 실제 이용자 글이 있는 곳은 87곳뿐이다.
 *    운영자가 넣은 시드를 이용자 후기로 착각해 우선순위를 주면 안 된다.
 */
async function pickStaleLots(db: D1Database): Promise<StaleLotRow[]> {
  const rows = await db
    .prepare(
      `SELECT p.id, p.name, p.address
         FROM parking_lot_stats s
         JOIN parking_lots p ON p.id = s.parking_lot_id
        WHERE s.ai_summary_stale = 1
        ORDER BY
          EXISTS (
            SELECT 1 FROM user_reviews r
             WHERE r.parking_lot_id = s.parking_lot_id AND r.is_seed = 0
          ) DESC,
          s.web_count DESC
        LIMIT ?1`,
    )
    .bind(MAX_PER_RUN)
    .all<StaleLotRow>()
  return rows.results ?? []
}

async function fetchLotInputs(
  db: D1Database,
  lotId: string,
): Promise<{
  web: LotSummaryWebRow[]
  reviews: LotSummaryReviewRow[]
  seedReviews: LotSummaryReviewRow[]
}> {
  const web = await db
    .prepare(
      // 정보 모음 사이트(경쟁 애그리게이터)는 후기가 아니라 공공데이터 재배포다.
      // 집계에 섞이면 요약이 우리 데이터를 되풀이하게 된다.
      `SELECT ai_summary AS content
         FROM web_sources
        WHERE parking_lot_id = ?1
          AND ai_summary IS NOT NULL AND ai_summary != ''
          AND filter_v2_reason IS NOT 'aggregator_site'
          AND relevance_score >= ?2
        ORDER BY relevance_score DESC
        LIMIT ?3`,
    )
    .bind(lotId, MIN_RELEVANCE, 30)
    .all<LotSummaryWebRow>()

  const reviewCols = `overall_score, entry_score, space_score, passage_score, exit_score, comment`
  // 시드 리뷰(is_seed=1)는 우리가 넣은 것이라 '이용자 후기'로 취급하면 안 된다.
  const reviews = await db
    .prepare(
      `SELECT ${reviewCols} FROM user_reviews
        WHERE parking_lot_id = ?1 AND is_seed = 0
        ORDER BY created_at DESC LIMIT ?2`,
    )
    .bind(lotId, REVIEW_LIMIT)
    .all<LotSummaryReviewRow>()

  const seedReviews = await db
    .prepare(
      `SELECT ${reviewCols} FROM user_reviews
        WHERE parking_lot_id = ?1 AND is_seed = 1
        ORDER BY created_at DESC LIMIT ?2`,
    )
    .bind(lotId, SEED_REVIEW_LIMIT)
    .all<LotSummaryReviewRow>()

  const realReviews = reviews.results ?? []
  // 리뷰가 있으면 웹 근거를 깎아 이용자 신호가 묻히지 않게 한다 (lot-summary-input.ts 기준)
  const quota = webQuotaFor(realReviews.length)

  return {
    web: (web.results ?? []).slice(0, quota),
    reviews: realReviews,
    seedReviews: seedReviews.results ?? [],
  }
}

/** 응답이 사양을 못 지키면 null. 네트워크·서버 실패는 throw 해서 재시도 대상으로 남긴다. */
async function generateLotSummary(
  lot: StaleLotRow,
  inputs: {
    web: LotSummaryWebRow[]
    reviews: LotSummaryReviewRow[]
    seedReviews: LotSummaryReviewRow[]
  },
  env: { UNSLOTH_API_KEY?: string; AI_MODEL?: string; AI_BASE_URL?: string },
): Promise<LotSummaryResult | null> {
  const text = await callAiText({
    apiKey: env.UNSLOTH_API_KEY as string,
    model: env.AI_MODEL || undefined,
    baseUrl: env.AI_BASE_URL || undefined,
    system: LOT_SUMMARY_SYSTEM_PROMPT,
    // reasoning 상수항 + summary 180자 + 팁 3개
    maxTokens: 2000,
    user: buildLotSummaryUserPrompt(lot, inputs.web, inputs.reviews, inputs.seedReviews),
  })

  const parsed = parseAiJson<Partial<LotSummaryResult>>(text)
  const summary = parsed?.summary?.trim()
  if (!summary || summary.length < MIN_LOT_SUMMARY_LENGTH) return null

  const pollution = detectSummaryPollution(summary)
  if (pollution) {
    console.log(`[lot-summary] rejected lot=${lot.id}: ${pollution}`)
    return null
  }

  const tip = (value: string | null | undefined): string | null => {
    const t = value?.trim()
    if (!t || t === 'null') return null
    return detectSummaryPollution(t) ? null : t
  }

  return {
    summary,
    tip_pricing: tip(parsed?.tip_pricing),
    tip_visit: tip(parsed?.tip_visit),
    tip_alternative: tip(parsed?.tip_alternative),
  }
}

async function saveSummary(db: D1Database, lotId: string, result: LotSummaryResult): Promise<void> {
  await db
    .prepare(
      // 여기서 stale 을 반드시 0 으로 내린다. 안 내리면 같은 곳이 매 회차 상한을 먹는다.
      `INSERT INTO parking_lot_stats
         (parking_lot_id, ai_summary, ai_summary_updated_at,
          ai_tip_pricing, ai_tip_visit, ai_tip_alternative, ai_tip_updated_at, ai_summary_stale)
       VALUES (?1, ?2, datetime('now'), ?3, ?4, ?5, datetime('now'), 0)
       ON CONFLICT(parking_lot_id) DO UPDATE SET
         ai_summary = excluded.ai_summary,
         ai_summary_updated_at = excluded.ai_summary_updated_at,
         ai_tip_pricing = excluded.ai_tip_pricing,
         ai_tip_visit = excluded.ai_tip_visit,
         ai_tip_alternative = excluded.ai_tip_alternative,
         ai_tip_updated_at = excluded.ai_tip_updated_at,
         ai_summary_stale = 0`,
    )
    .bind(lotId, result.summary, result.tip_pricing, result.tip_visit, result.tip_alternative)
    .run()
}

async function clearStale(db: D1Database, lotId: string): Promise<void> {
  await db
    .prepare(`UPDATE parking_lot_stats SET ai_summary_stale = 0 WHERE parking_lot_id = ?1`)
    .bind(lotId)
    .run()
}
