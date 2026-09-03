import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  enqueueSourceFilter,
  markSourceFilterTerminal,
  processSourceFilterMessages,
  type SourceFilterMessage,
} from './source-filter'

/**
 * 조회 결과는 `rows` 로 주고, 쓰기는 `batched` 에 모은다.
 * 조회 SQL 에 실린 바인딩도 남긴다 — 멱등성 조건이 쿼리에 있는지 보기 위해서다.
 */
function makeDb(rows: unknown[]) {
  const batched: string[] = []
  let selectSql = ''
  let selectArgs: unknown[] = []
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        const stmt = {
          all: async () => {
            selectSql = sql
            selectArgs = args
            return { results: rows }
          },
          __sql: sql,
        }
        return stmt
      },
    }),
    batch: async (statements: Array<{ __sql: string }>) => {
      for (const s of statements) batched.push(s.__sql)
      return []
    },
  } as unknown as D1Database
  return {
    db,
    batched,
    select: () => ({ sql: selectSql, args: selectArgs }),
  }
}

const BLOG_BODY = `주차장 입구가 좁아 진입할 때 주의가 필요합니다. ${'주차 요금은 10분당 500원이고 최초 30분은 무료입니다. '.repeat(20)}`

afterEach(() => {
  delete (env as unknown as Record<string, unknown>).SOURCE_FILTER_QUEUE
  vi.restoreAllMocks()
})

describe('enqueueSourceFilter', () => {
  it('큐가 없으면 0을 돌려준다 — 호출부가 직접 처리로 넘어갈 수 있게', async () => {
    expect(await enqueueSourceFilter([1, 2, 3])).toEqual({ enqueued: 0 })
  })

  it('100개 단위로 끊어 보낸다', async () => {
    const sendBatch = vi.fn(async (_msgs: Array<{ body: SourceFilterMessage }>) => {})
    ;(env as unknown as Record<string, unknown>).SOURCE_FILTER_QUEUE = { sendBatch }

    const result = await enqueueSourceFilter(Array.from({ length: 250 }, (_, i) => i + 1))

    expect(result).toEqual({ enqueued: 250 })
    expect(sendBatch).toHaveBeenCalledTimes(3)
    // 메시지 본문은 id 하나뿐이다 (본문을 실으면 메시지가 원본과 어긋난다)
    expect(sendBatch.mock.calls[0]?.[0][0]).toEqual({ body: { rawId: 1 } })
  })

  it('sendBatch 실패는 throw 하지 않는다 — 크론 나머지 단계를 막지 않는다', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    ;(env as unknown as Record<string, unknown>).SOURCE_FILTER_QUEUE = {
      sendBatch: vi.fn(async () => {
        throw new Error('queue down')
      }),
    }

    expect(await enqueueSourceFilter([1, 2])).toEqual({ enqueued: 0 })
  })
})

describe('processSourceFilterMessages', () => {
  it('중복 배달된 메시지를 id 단위로 합친다', async () => {
    const { db, select } = makeDb([])

    const result = await processSourceFilterMessages(db, [{ rawId: 1 }, { rawId: 1 }, { rawId: 2 }])

    expect(result.requested).toBe(2)
    expect(select().args).toEqual([1, 2])
  })

  it('이미 처리된 행을 SQL 단계에서 거른다 (at-least-once 대비)', async () => {
    const { db, select } = makeDb([])
    await processSourceFilterMessages(db, [{ rawId: 1 }])
    expect(select().sql).toContain('ai_filtered_at IS NULL')
  })

  it('정보 모음 사이트는 본문과 무관하게 즉시 제거한다', async () => {
    const { db, batched } = makeDb([
      {
        id: 1,
        title: '주차장 정보',
        source_url: 'https://jucha.kr/lot/123',
        full_text: BLOG_BODY,
        full_text_status: 'ok',
      },
    ])

    const result = await processSourceFilterMessages(db, [{ rawId: 1 }])

    expect(result.removed).toBe(1)
    expect(batched[0]).toContain("filter_removed_by = 'aggregator_site'")
  })

  it('rule 통과 건은 filter_passed=1 로 match 단계에 넘긴다', async () => {
    const { db, batched } = makeDb([
      {
        id: 2,
        title: '○○ 공영주차장 다녀왔습니다',
        source_url: 'https://blog.naver.com/someone/1',
        full_text: BLOG_BODY,
        full_text_status: 'ok',
      },
    ])

    const result = await processSourceFilterMessages(db, [{ rawId: 2 }])

    expect(result.passed).toBe(1)
    expect(batched[0]).toContain('filter_passed = 1')
  })

  it('조회 결과가 없으면 쓰기도 하지 않는다', async () => {
    const { db, batched } = makeDb([])
    const result = await processSourceFilterMessages(db, [{ rawId: 9 }])
    expect(result.filtered).toBe(0)
    expect(batched).toHaveLength(0)
  })
})

describe('markSourceFilterTerminal', () => {
  it('계속 실패하는 행을 생산자 대상에서 빼낸다', async () => {
    const { db, batched } = makeDb([])

    const marked = await markSourceFilterTerminal(db, [7, 8])

    expect(marked).toBe(2)
    // 생산자 조회 조건이 `ai_filtered_at IS NULL` 이라, 이 값을 채워야 고리가 끊긴다
    expect(batched[0]).toContain("ai_filtered_at = datetime('now')")
    expect(batched[0]).toContain("filter_removed_by = 'consumer_error'")
    // 이미 처리된 행을 덮어쓰지 않는다
    expect(batched[0]).toContain('AND ai_filtered_at IS NULL')
  })

  it('빈 목록이면 쓰지 않는다', async () => {
    const { db, batched } = makeDb([])
    expect(await markSourceFilterTerminal(db, [])).toBe(0)
    expect(batched).toHaveLength(0)
  })
})
