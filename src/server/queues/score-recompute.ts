import { env } from 'cloudflare:workers'
import { recomputeStats } from '@/server/crawlers/lib/scoring-engine'

export type ScoreRecomputeReason = 'review_created' | 'review_deleted'

export interface ScoreRecomputeMessage {
  lotId: string
  reason: ScoreRecomputeReason
}

export interface ScoreRecomputeProcessResult {
  updated: number
  lotIds: string[]
  messageCount: number
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
    return { updated: 0, lotIds: [], messageCount: messages.length }
  }

  const result = await recomputeStats(db, ids)
  return { updated: result.updated, lotIds: ids, messageCount: messages.length }
}
