import { timeDecay } from './sentiment'

export const SCORE_PARAMS = {
  PRIOR_C: 2.5,
  SOURCE_WEIGHTS: {
    review: 0.6,
    web: 0.4,
  },
  TEXT_N_EFFECTIVE_WEIGHT: 0.1,
  HELL_SCORE_CAP: 2.9,
  PRIOR_MECHANICAL: -0.2,
  PRIOR_SMALL_LOT: -0.1,
  PRIOR_LARGE_LOT: 0.05,
  PRIOR_XLARGE_LOT: 0,
  PRIOR_UNDERGROUND: -0.15,
  PRIOR_OUTDOOR: 0,
  PRIOR_FREE: 0,
} as const

export interface ScoringLot {
  name: string
  type: string | null
  total_spaces: number | null
  is_free: number | null
  notes: string | null
  curation_tag?: string | null
}

export interface ReviewSignal {
  overall_score: number
  is_seed: number
  source_type: string | null
  created_at: string
}

export interface WebSignal {
  sentiment_score: number | null
  relevance_score: number
  published_at: string | null
  match_type: 'direct' | 'ai_high' | 'ai_medium' | string
}

export interface SourceScores {
  reviewScore: number | null
  reviewCount: number
  webScore: number | null
  webCount: number
  nEffective: number
}

export interface FinalScoreResult {
  finalScore: number
  reliability: string
}

const MATCH_TYPE_FACTOR: Record<string, number> = {
  direct: 1.0,
  ai_high: 0.8,
  ai_medium: 0.5,
}

export function computeStructuralPrior(lot: ScoringLot): number {
  let score = 3.0
  const nameNotes = `${lot.name} ${lot.notes ?? ''}`.toLowerCase()

  if (nameNotes.includes('기계식') || nameNotes.includes('기계')) {
    score += SCORE_PARAMS.PRIOR_MECHANICAL
  }

  if (lot.total_spaces !== null) {
    if (lot.total_spaces < 30) score += SCORE_PARAMS.PRIOR_SMALL_LOT
    if (lot.total_spaces > 500) score += SCORE_PARAMS.PRIOR_XLARGE_LOT
    else if (lot.total_spaces > 200) score += SCORE_PARAMS.PRIOR_LARGE_LOT
  }

  if (nameNotes.includes('지하')) score += SCORE_PARAMS.PRIOR_UNDERGROUND
  if (lot.type === '노외') score += SCORE_PARAMS.PRIOR_OUTDOOR
  if (lot.is_free === 1) score += SCORE_PARAMS.PRIOR_FREE

  return Math.max(1.0, Math.min(5.0, score))
}

function weightedAvg(
  items: { score: number; date: string | null; weight: number }[],
  now: Date,
): number | null {
  if (items.length === 0) return null

  let weightedSum = 0
  let weightTotal = 0
  for (const item of items) {
    const decay = timeDecay(item.date, now)
    weightedSum += item.weight * decay * item.score
    weightTotal += item.weight * decay
  }

  return weightTotal > 0 ? weightedSum / weightTotal : null
}

function reviewWeight(review: ReviewSignal): number {
  if (review.is_seed === 1) return 0.3
  if (review.source_type !== null) return 0.6
  return 3.0
}

function roundScore(score: number | null): number | null {
  return score === null ? null : Math.round(score * 100) / 100
}

export function computeSourceScores(
  reviews: ReviewSignal[],
  webSignals: WebSignal[],
  now: Date,
): SourceScores {
  const reviewScore = weightedAvg(
    reviews.map((review) => ({
      score: review.overall_score,
      date: review.created_at,
      weight: reviewWeight(review),
    })),
    now,
  )

  const relevantWebSignals = webSignals.filter(
    (signal) => signal.relevance_score > 30 && signal.sentiment_score !== null,
  )
  const webScore = weightedAvg(
    relevantWebSignals.map((signal) => ({
      score: signal.sentiment_score ?? 3.0,
      date: signal.published_at,
      weight: (signal.relevance_score / 100) * (MATCH_TYPE_FACTOR[signal.match_type] ?? 0.5),
    })),
    now,
  )

  const highRelevanceWebSignals = relevantWebSignals.filter(
    (signal) => signal.relevance_score >= 70,
  )
  const highWebCount = highRelevanceWebSignals.length
  const webWeight =
    highWebCount === 0 ? 0 : Math.min(SCORE_PARAMS.TEXT_N_EFFECTIVE_WEIGHT, 1 / highWebCount)

  const reviewEffective = reviews.reduce((sum, review) => sum + reviewWeight(review), 0)
  const webEffective = highRelevanceWebSignals.reduce(
    (sum, signal) => sum + webWeight * (MATCH_TYPE_FACTOR[signal.match_type] ?? 0.5),
    0,
  )

  return {
    reviewScore: roundScore(reviewScore),
    reviewCount: reviews.length,
    webScore: roundScore(webScore),
    webCount: relevantWebSignals.length,
    nEffective: Math.round((reviewEffective + webEffective) * 100) / 100,
  }
}

export function computeFinalScore(prior: number, sources: SourceScores): FinalScoreResult {
  const active: { weight: number; score: number }[] = []

  if (sources.reviewScore !== null) {
    active.push({ weight: SCORE_PARAMS.SOURCE_WEIGHTS.review, score: sources.reviewScore })
  }
  if (sources.webScore !== null) {
    active.push({ weight: SCORE_PARAMS.SOURCE_WEIGHTS.web, score: sources.webScore })
  }

  if (active.length === 0) {
    return {
      finalScore: Math.round(prior * 100) / 100,
      reliability: prior !== 3.0 ? 'structural' : 'none',
    }
  }

  const totalWeight = active.reduce((sum, item) => sum + item.weight, 0)
  const rawScore = active.reduce((sum, item) => sum + (item.weight / totalWeight) * item.score, 0)
  const finalScore =
    (SCORE_PARAMS.PRIOR_C * prior + sources.nEffective * rawScore) /
    (SCORE_PARAMS.PRIOR_C + sources.nEffective)

  const floored =
    sources.nEffective < 1 && sources.reviewCount === 0 ? Math.max(finalScore, prior) : finalScore

  const clamped = Math.max(1.0, Math.min(5.0, Math.round(floored * 100) / 100))

  let reliability: string
  if (sources.nEffective >= 5) reliability = 'confirmed'
  else if (sources.nEffective >= 1) reliability = 'estimated'
  else if (sources.nEffective > 0) reliability = 'reference'
  else reliability = 'structural'

  return { finalScore: clamped, reliability }
}

export function applyCurationCap(lot: ScoringLot, finalScore: number): number {
  return lot.curation_tag === 'hell'
    ? Math.min(finalScore, SCORE_PARAMS.HELL_SCORE_CAP)
    : finalScore
}
