import { env } from 'cloudflare:workers'
import { recomputeStats } from '@/server/crawlers/lib/scoring-engine'

export type ScoreRecomputeReason =
  | 'review_created'
  | 'review_deleted'
  /** 크론 매칭으로 web_sources 에 새 근거가 붙었을 때 */
  | 'web_source_matched'

/**
 * 종합 요약을 다시 만들 만한 변화인지 판정할 때 쓰는 기준.
 *
 * 이용자 리뷰는 건수 조건 없이 즉시 다시 만든다 — 우리 신뢰 등급에서 1순위 근거이고,
 * 실사용자 리뷰 보유 lot 이 87곳뿐이라 비용이 미미하다.
 * 블로그 근거는 1건 들어올 때마다 다시 만들면 낭비라, 쌓일 때까지 기다린다.
 */
export const WEB_EVIDENCE_THRESHOLD = 3
export const SUMMARY_MAX_AGE_DAYS = 90

export interface ScoreRecomputeMessage {
  lotId: string
  reason: ScoreRecomputeReason
}

export interface ScoreRecomputeProcessResult {
  updated: number
  lotIds: string[]
  messageCount: number
  /** 종합 요약 재생성 대기로 새로 표시된 lot 수 */
  staleMarked: number
}

function getScoreRecomputeQueue(): Queue<ScoreRecomputeMessage> | undefined {
  return (env as unknown as { SCORE_RECOMPUTE_QUEUE?: Queue<ScoreRecomputeMessage> })
    .SCORE_RECOMPUTE_QUEUE
}

export async function enqueueScoreRecompute(
  msg: ScoreRecomputeMessage,
): Promise<{ enqueued: boolean }> {
  try {
    const queue = getScoreRecomputeQueue()
    if (!queue) {
      console.error('[score-recompute-queue] binding missing, skip enqueue', msg)
      return { enqueued: false }
    }

    await queue.send(msg)
    return { enqueued: true }
  } catch (err) {
    console.error('[score-recompute-queue] enqueue failed', msg, err)
    return { enqueued: false }
  }
}

/**
 * 여러 lot 을 한 번에 큐에 넣는다.
 *
 * 매칭 배치는 한 번에 수십 개 lot 을 건드리는데, lot 마다 `send()` 를 부르면
 * 그만큼 subrequest 를 쓴다 (Workers 는 invocation 당 1,000개 제한).
 * `sendBatch` 한 번은 100개까지 담는다.
 */
export async function enqueueScoreRecomputeBatch(
  msgs: readonly ScoreRecomputeMessage[],
): Promise<{ enqueued: number }> {
  if (msgs.length === 0) return { enqueued: 0 }
  const queue = getScoreRecomputeQueue()
  if (!queue) {
    console.error('[score-recompute-queue] binding missing, skip enqueue', msgs.length)
    return { enqueued: 0 }
  }

  const QUEUE_SEND_BATCH_LIMIT = 100
  let enqueued = 0
  for (let i = 0; i < msgs.length; i += QUEUE_SEND_BATCH_LIMIT) {
    const chunk = msgs.slice(i, i + QUEUE_SEND_BATCH_LIMIT)
    try {
      await queue.sendBatch(chunk.map((body) => ({ body })))
      enqueued += chunk.length
    } catch (err) {
      console.error('[score-recompute-queue] sendBatch failed', chunk.length, err)
    }
  }
  return { enqueued }
}

export async function processScoreRecomputeMessages(
  db: D1Database,
  messages: readonly ScoreRecomputeMessage[],
): Promise<ScoreRecomputeProcessResult> {
  const lotIds = new Set<string>()
  for (const message of messages) {
    if (typeof message.lotId === 'string' && message.lotId.length > 0) {
      lotIds.add(message.lotId)
    }
  }

  const ids = [...lotIds]
  if (ids.length === 0) {
    return { updated: 0, lotIds: [], messageCount: messages.length, staleMarked: 0 }
  }

  const result = await recomputeStats(db, ids)

  // 요약은 여기서 만들지 않는다. AI 호출이라 배치가 길어지고, 큐는 빨라야 한다.
  // "다시 만들어야 한다"는 표시만 남기고 실제 생성은 크론이 회당 상한을 걸어 처리한다.
  const humanEvidenceLots = new Set(
    messages
      .filter((m) => m.reason === 'review_created' || m.reason === 'review_deleted')
      .map((m) => m.lotId),
  )
  const staleMarked = await markSummaryStale(db, ids, humanEvidenceLots)

  return {
    updated: result.updated,
    lotIds: ids,
    messageCount: messages.length,
    staleMarked,
  }
}

/**
 * 종합 요약 재생성 대기 표시.
 *
 * 사람 근거(이용자 리뷰)가 바뀐 lot 은 조건 없이 세운다.
 * 웹 근거만 바뀐 lot 은 마지막 요약 이후 새 근거가 임계 이상 쌓였거나,
 * 요약이 너무 오래됐을 때만 세운다.
 */
async function markSummaryStale(
  db: D1Database,
  lotIds: string[],
  humanEvidenceLots: Set<string>,
): Promise<number> {
  let marked = 0
  for (const lotId of lotIds) {
    try {
      if (humanEvidenceLots.has(lotId)) {
        const r = await db
          .prepare(
            `UPDATE parking_lot_stats SET ai_summary_stale = 1
              WHERE parking_lot_id = ?1 AND ai_summary_stale = 0`,
          )
          .bind(lotId)
          .run()
        marked += r.meta?.changes ?? 0
        continue
      }

      // 웹 근거만 바뀐 경우 — 아직 요약이 없거나, 새 근거가 충분히 쌓였거나, 오래됐을 때
      const r = await db
        .prepare(
          `UPDATE parking_lot_stats SET ai_summary_stale = 1
            WHERE parking_lot_id = ?1
              AND ai_summary_stale = 0
              AND (
                ai_summary IS NULL
                OR ai_summary_updated_at IS NULL
                OR datetime(ai_summary_updated_at) < datetime('now', ?3)
                OR (
                  SELECT COUNT(*) FROM web_sources ws
                   WHERE ws.parking_lot_id = ?1
                     AND ws.matched_at > parking_lot_stats.ai_summary_updated_at
                ) >= ?2
              )`,
        )
        .bind(lotId, WEB_EVIDENCE_THRESHOLD, `-${SUMMARY_MAX_AGE_DAYS} days`)
        .run()
      marked += r.meta?.changes ?? 0
    } catch (err) {
      // 표시 실패가 평점 재계산을 막지는 않게 한다
      console.error('[score-recompute-queue] stale mark failed', lotId, err)
    }
  }
  return marked
}
