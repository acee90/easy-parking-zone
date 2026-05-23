import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enqueueScoreRecompute, processScoreRecomputeMessages } from './score-recompute'

vi.mock('@/server/crawlers/lib/scoring-engine', () => ({
  recomputeStats: vi.fn(async (_db: D1Database, lotIds: string[]) => ({ updated: lotIds.length })),
}))

describe('score-recompute queue helpers', () => {
  afterEach(() => {
    delete (env as Record<string, unknown>).SCORE_RECOMPUTE_QUEUE
    vi.restoreAllMocks()
  })

  it('queue binding이 있으면 메시지를 enqueue한다', async () => {
    const send = vi.fn(async () => {})
    ;(env as Record<string, unknown>).SCORE_RECOMPUTE_QUEUE = { send }

    const result = await enqueueScoreRecompute({
      lotId: 'KA-1',
      reason: 'review_created',
    })

    expect(result).toEqual({ enqueued: true })
    expect(send).toHaveBeenCalledWith({ lotId: 'KA-1', reason: 'review_created' })
  })

  it('queue send 실패는 throw하지 않고 실패 결과를 반환한다', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(env as Record<string, unknown>).SCORE_RECOMPUTE_QUEUE = {
      send: vi.fn(async () => {
        throw new Error('queue down')
      }),
    }

    await expect(
      enqueueScoreRecompute({ lotId: 'KA-1', reason: 'review_deleted' }),
    ).resolves.toEqual({ enqueued: false })
  })

  it('consumer core는 lotId를 dedupe한다', async () => {
    const result = await processScoreRecomputeMessages({} as D1Database, [
      { lotId: 'KA-1', reason: 'review_created' },
      { lotId: 'KA-1', reason: 'review_deleted' },
      { lotId: 'KA-2', reason: 'review_created' },
    ])

    expect(result).toEqual({
      updated: 2,
      lotIds: ['KA-1', 'KA-2'],
      messageCount: 3,
    })
  })
})
