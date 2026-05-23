/**
 * 스코어링 엔진 — Workers 호환 (D1 바인딩 직접 사용)
 *
 * 변경된 주차장 ID만 받아서 해당 건의 점수를 재계산한다.
 */
import {
  applyCurationCap,
  computeFinalScore,
  computeSourceScores,
  computeStructuralPrior,
  type ReviewSignal,
  type ScoringLot,
  type WebSignal,
} from './scoring-engine-core'

interface ParkingLotRow extends ScoringLot {
  id: string
}

// ── 공개 API: 특정 주차장 ID 목록의 점수 재계산 ──

export async function recomputeStats(
  db: D1Database,
  lotIds: string[],
): Promise<{ updated: number }> {
  if (lotIds.length === 0) return { updated: 0 }

  const now = new Date()
  const placeholders = lotIds.map(() => '?').join(',')

  const lots = await db
    .prepare(
      `SELECT id, name, type, total_spaces, is_free, notes, curation_tag
       FROM parking_lots
       WHERE id IN (${placeholders})`,
    )
    .bind(...lotIds)
    .all<ParkingLotRow>()

  if (!lots.results || lots.results.length === 0) return { updated: 0 }

  const reviews = await db
    .prepare(
      `SELECT parking_lot_id, overall_score, is_seed, source_type, created_at
       FROM user_reviews
       WHERE parking_lot_id IN (${placeholders})`,
    )
    .bind(...lotIds)
    .all<ReviewSignal & { parking_lot_id: string }>()

  const reviewsByLot = new Map<string, ReviewSignal[]>()
  for (const review of reviews.results ?? []) {
    if (!reviewsByLot.has(review.parking_lot_id)) reviewsByLot.set(review.parking_lot_id, [])
    reviewsByLot.get(review.parking_lot_id)?.push(review)
  }

  const webSignals = await db
    .prepare(
      `SELECT ws.parking_lot_id, ws.sentiment_score, ws.relevance_score, ws.published_at, 'direct' as match_type
       FROM web_sources ws
       WHERE ws.parking_lot_id IN (${placeholders})
         AND ws.sentiment_score IS NOT NULL
         AND ws.relevance_score > 30
         AND ws.filter_passed_v2 = 1
       UNION ALL
       SELECT am.parking_lot_id, ws.sentiment_score, ws.relevance_score, ws.published_at,
              CASE am.confidence WHEN 'high' THEN 'ai_high' ELSE 'ai_medium' END as match_type
       FROM web_source_ai_matches am
       JOIN web_sources ws ON ws.id = am.web_source_id
       WHERE am.parking_lot_id IN (${placeholders})
         AND ws.sentiment_score IS NOT NULL
         AND ws.relevance_score > 30
         AND ws.filter_passed_v2 = 1
         AND am.confidence IN ('high', 'medium')
         AND (ws.parking_lot_id IS NULL OR am.parking_lot_id != ws.parking_lot_id)`,
    )
    .bind(...lotIds, ...lotIds)
    .all<WebSignal & { parking_lot_id: string }>()

  const webSignalsByLot = new Map<string, WebSignal[]>()
  for (const signal of webSignals.results ?? []) {
    if (!webSignalsByLot.has(signal.parking_lot_id)) {
      webSignalsByLot.set(signal.parking_lot_id, [])
    }
    webSignalsByLot.get(signal.parking_lot_id)?.push(signal)
  }

  const batch: D1PreparedStatement[] = []

  for (const lot of lots.results) {
    const prior = computeStructuralPrior(lot)
    const sources = computeSourceScores(
      reviewsByLot.get(lot.id) ?? [],
      webSignalsByLot.get(lot.id) ?? [],
      now,
    )
    const { finalScore: rawFinalScore, reliability } = computeFinalScore(prior, sources)
    const finalScore = applyCurationCap(lot, rawFinalScore)

    batch.push(
      db
        .prepare(
          `INSERT INTO parking_lot_stats
           (parking_lot_id, structural_prior, review_score, review_count, web_score, web_count,
            n_effective, final_score, reliability, computed_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'))
           ON CONFLICT(parking_lot_id) DO UPDATE SET
             structural_prior = excluded.structural_prior,
             review_score = excluded.review_score,
             review_count = excluded.review_count,
             web_score = excluded.web_score,
             web_count = excluded.web_count,
             n_effective = excluded.n_effective,
             final_score = excluded.final_score,
             reliability = excluded.reliability,
             computed_at = excluded.computed_at`,
        )
        .bind(
          lot.id,
          prior,
          sources.reviewScore,
          sources.reviewCount,
          sources.webScore,
          sources.webCount,
          sources.nEffective,
          finalScore,
          reliability,
        ),
    )
  }

  if (batch.length > 0) {
    const CHUNK = 500
    for (let i = 0; i < batch.length; i += CHUNK) {
      await db.batch(batch.slice(i, i + CHUNK))
    }
  }

  return { updated: batch.length }
}
