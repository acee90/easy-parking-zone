import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueScoreRecompute,
  enqueueScoreRecomputeBatch,
  processScoreRecomputeMessages,
  SUMMARY_MAX_AGE_DAYS,
  WEB_EVIDENCE_THRESHOLD,
} from './score-recompute'

vi.mock('@/server/crawlers/lib/scoring-engine', () => ({
  recomputeStats: vi.fn(async (_db: D1Database, lotIds: string[]) => ({ updated: lotIds.length })),
}))

/** markSummaryStale 이 날리는 UPDATE 를 받아 적는 최소 D1 스텁 */
function makeDb() {
  const calls: Array<{ sql: string; args: unknown[] }> = []
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        run: async () => {
          calls.push({ sql, args })
          return { meta: { changes: 1 } }
        },
      }),
    }),
  } as unknown as D1Database
  return { db, calls }
}

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
    const { db } = makeDb()
    const result = await processScoreRecomputeMessages(db, [
      { lotId: 'KA-1', reason: 'review_created' },
      { lotId: 'KA-1', reason: 'review_deleted' },
      { lotId: 'KA-2', reason: 'review_created' },
    ])

    expect(result.updated).toBe(2)
    expect(result.lotIds).toEqual(['KA-1', 'KA-2'])
    expect(result.messageCount).toBe(3)
  })

  it('이용자 리뷰가 바뀐 lot 은 조건 없이 요약 재생성 대기로 표시한다', async () => {
    const { db, calls } = makeDb()
    const result = await processScoreRecomputeMessages(db, [
      { lotId: 'KA-1', reason: 'review_created' },
    ])

    expect(result.staleMarked).toBe(1)
    // 리뷰 경로는 건수·경과일 조건을 보지 않는다 — UPDATE 문에 그 조건이 없어야 한다
    expect(calls[0].sql).not.toContain('COUNT(*)')
  })

  it('웹 근거만 바뀐 lot 은 누적 건수·경과일 조건을 걸어 표시한다', async () => {
    const { db, calls } = makeDb()
    await processScoreRecomputeMessages(db, [{ lotId: 'KA-1', reason: 'web_source_matched' }])

    expect(calls[0].sql).toContain('COUNT(*)')
    // 임계값이 바인딩으로 들어간다 (프롬프트 문장이 아니라 숫자로 강제한다)
    expect(calls[0].args).toEqual(['KA-1', WEB_EVIDENCE_THRESHOLD, `-${SUMMARY_MAX_AGE_DAYS} days`])
  })

  it('표시 실패가 평점 재계산 결과를 무너뜨리지 않는다', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const db = {
      prepare: () => ({
        bind: () => ({
          run: async () => {
            throw new Error('d1 down')
          },
        }),
      }),
    } as unknown as D1Database

    const result = await processScoreRecomputeMessages(db, [
      { lotId: 'KA-1', reason: 'review_created' },
    ])

    expect(result.updated).toBe(1)
    expect(result.staleMarked).toBe(0)
  })

  it('sendBatch 는 100개 단위로 끊어 보낸다', async () => {
    const sendBatch = vi.fn(async () => {})
    ;(env as Record<string, unknown>).SCORE_RECOMPUTE_QUEUE = { sendBatch }

    const msgs = Array.from({ length: 150 }, (_, i) => ({
      lotId: `KA-${i}`,
      reason: 'web_source_matched' as const,
    }))
    const result = await enqueueScoreRecomputeBatch(msgs)

    expect(result).toEqual({ enqueued: 150 })
    expect(sendBatch).toHaveBeenCalledTimes(2)
  })
})
