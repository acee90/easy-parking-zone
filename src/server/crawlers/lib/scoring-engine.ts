/**
 * 스코어링 엔진 — Workers 호환 (D1 바인딩 직접 사용)
 *
 * compute-parking-stats.ts의 핵심 로직을 Workers에서 실행 가능하도록 추출.
 * 변경된 주차장 ID만 받아서 해당 건의 점수를 재계산.
 */
import { timeDecay } from './sentiment'

const C = 1.5

const WEIGHTS = {
  user: 0.5,
  community: 0.3,
  blog: 0.15,
  youtube: 0.15,
} as const

// ── 구조적 사전 점수 (§4.1) ──

interface ParkingLotRow {
  id: string
  name: string
  type: string | null
  total_spaces: number | null
  is_free: number | null
  notes: string | null
}

function computeStructuralPrior(lot: ParkingLotRow): number {
  let score = 3.0
  const nameNotes = `${lot.name} ${lot.notes ?? ''}`.toLowerCase()

  if (nameNotes.includes('기계식') || nameNotes.includes('기계')) score -= 0.15
  if (lot.total_spaces !== null) {
    if (lot.total_spaces < 30) score -= 0.05
    if (lot.total_spaces > 200) score += 0.1
  }
  if (nameNotes.includes('지하')) score -= 0.05
  if (lot.type === '노외') score += 0.08
  if (lot.is_free === 1) score += 0.04

  return Math.max(1.0, Math.min(5.0, score))
}

// ── 소스별 점수 집계 (§4.2~4.3) ──

interface ReviewRow {
  overall_score: number
  is_seed: number
  source_type: string | null
  created_at: string
}

interface TextRow {
  sentiment_score: number
  relevance_score: number
  published_at: string | null
  match_type: string // direct, ai_high, ai_medium
}

const MATCH_TYPE_FACTOR: Record<string, number> = {
  direct: 1.0,
  ai_high: 0.8,
  ai_medium: 0.5,
}

function weightedAvg(
  items: { score: number; date: string; weight: number }[],
  now: Date,
): number | null {
  if (items.length === 0) return null
  let wSum = 0
  let wTotal = 0
  for (const item of items) {
    const d = timeDecay(item.date, now)
    wSum += item.weight * d * item.score
    wTotal += item.weight * d
  }
  return wTotal > 0 ? wSum / wTotal : null
}

function computeSourceScores(reviews: ReviewRow[], texts: TextRow[], now: Date) {
  const userReviews = reviews.filter((r) => r.source_type === null && r.is_seed === 0)
  const communityReviews = reviews.filter((r) => r.source_type !== null || r.is_seed === 1)

  const userReviewScore = weightedAvg(
    userReviews.map((r) => ({ score: r.overall_score, date: r.created_at, weight: 1.0 })),
    now,
  )
  const communityScore = weightedAvg(
    communityReviews.map((r) => ({
      score: r.overall_score,
      date: r.created_at,
      weight: r.is_seed === 1 ? 0.3 : 0.6,
    })),
    now,
  )

  const relevantTexts = texts.filter((t) => t.relevance_score > 30 && t.sentiment_score !== null)
  const textScore = weightedAvg(
    relevantTexts.map((t) => ({
      score: t.sentiment_score,
      date: t.published_at ?? '',
      weight: (t.relevance_score / 100) * (MATCH_TYPE_FACTOR[t.match_type] ?? 0.5),
    })),
    now,
  )

  const highRelevanceTexts = texts.filter((t) => t.relevance_score >= 70)
  const nEffective =
    userReviews.length * 1.0 +
    communityReviews.length * 0.6 +
    highRelevanceTexts.reduce((sum, t) => sum + 0.2 * (MATCH_TYPE_FACTOR[t.match_type] ?? 0.5), 0)

  return {
    userReviewScore: userReviewScore ? Math.round(userReviewScore * 100) / 100 : null,
    userReviewCount: userReviews.length,
    communityScore: communityScore ? Math.round(communityScore * 100) / 100 : null,
    communityCount: communityReviews.length,
    textScore: textScore ? Math.round(textScore * 100) / 100 : null,
    textCount: relevantTexts.length,
    nEffective: Math.round(nEffective * 100) / 100,
  }
}

// ── 베이지안 통합 (§4.4) ──

function computeFinalScore(prior: number, sources: ReturnType<typeof computeSourceScores>) {
  const active: { weight: number; score: number }[] = []

  if (sources.userReviewScore !== null)
    active.push({ weight: WEIGHTS.user, score: sources.userReviewScore })
  if (sources.communityScore !== null)
    active.push({ weight: WEIGHTS.community, score: sources.communityScore })
  if (sources.textScore !== null)
    active.push({ weight: WEIGHTS.blog + WEIGHTS.youtube, score: sources.textScore })

  if (active.length === 0) {
    return {
      finalScore: Math.round(prior * 100) / 100,
      reliability: prior !== 3.0 ? 'structural' : 'none',
    }
  }

  const totalWeight = active.reduce((s, a) => s + a.weight, 0)
  const rawScore = active.reduce((s, a) => s + (a.weight / totalWeight) * a.score, 0)
  const finalScore = (C * prior + sources.nEffective * rawScore) / (C + sources.nEffective)
  const clamped = Math.max(1.0, Math.min(5.0, Math.round(finalScore * 100) / 100))

  let reliability: string
  if (sources.nEffective >= 5) reliability = 'confirmed'
  else if (sources.nEffective >= 1) reliability = 'estimated'
  else if (sources.nEffective > 0) reliability = 'reference'
  else reliability = 'structural'

  return { finalScore: clamped, reliability }
}

// ── 공개 API: 특정 주차장 ID 목록의 점수 재계산 ──

export async function recomputeStats(
  db: D1Database,
  lotIds: string[],
): Promise<{ updated: number }> {
  if (lotIds.length === 0) return { updated: 0 }

  const now = new Date()
  const placeholders = lotIds.map(() => '?').join(',')

  // 대상 주차장 정보
  const lots = await db
    .prepare(
      `SELECT id, name, type, total_spaces, is_free, notes FROM parking_lots WHERE id IN (${placeholders})`,
    )
    .bind(...lotIds)
    .all<ParkingLotRow>()

  if (!lots.results || lots.results.length === 0) return { updated: 0 }

  // 리뷰 로드
  const reviews = await db
    .prepare(
      `SELECT parking_lot_id, overall_score, is_seed, source_type, created_at FROM user_reviews WHERE parking_lot_id IN (${placeholders})`,
    )
    .bind(...lotIds)
    .all<ReviewRow & { parking_lot_id: string }>()

  const reviewsByLot = new Map<string, ReviewRow[]>()
  for (const r of reviews.results ?? []) {
    if (!reviewsByLot.has(r.parking_lot_id)) reviewsByLot.set(r.parking_lot_id, [])
    reviewsByLot.get(r.parking_lot_id)?.push(r)
  }

  // 텍스트 감성 로드 (직접 + AI 매칭)
  const texts = await db
    .prepare(
      `SELECT ws.parking_lot_id, ws.sentiment_score, ws.relevance_score, ws.published_at, 'direct' as match_type
       FROM web_sources ws
       WHERE ws.parking_lot_id IN (${placeholders})
         AND ws.sentiment_score IS NOT NULL AND ws.relevance_score > 30`,
    )
    .bind(...lotIds)
    .all<TextRow & { parking_lot_id: string }>()

  const textsByLot = new Map<string, TextRow[]>()
  for (const t of texts.results ?? []) {
    if (!textsByLot.has(t.parking_lot_id)) textsByLot.set(t.parking_lot_id, [])
    textsByLot.get(t.parking_lot_id)?.push(t)
  }

  // 주차장별 스코어링 + DB 업데이트
  const batch: D1PreparedStatement[] = []

  for (const lot of lots.results) {
    const prior = computeStructuralPrior(lot)
    const lotReviews = reviewsByLot.get(lot.id) ?? []
    const lotTexts = textsByLot.get(lot.id) ?? []
    const sources = computeSourceScores(lotReviews, lotTexts, now)
    const { finalScore, reliability } = computeFinalScore(prior, sources)

    batch.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO parking_lot_stats
         (parking_lot_id, structural_prior, user_review_score, user_review_count,
          community_score, community_count, text_sentiment_score, text_source_count,
          n_effective, final_score, reliability, computed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, datetime('now'))`,
        )
        .bind(
          lot.id,
          prior,
          sources.userReviewScore,
          sources.userReviewCount,
          sources.communityScore,
          sources.communityCount,
          sources.textScore,
          sources.textCount,
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
