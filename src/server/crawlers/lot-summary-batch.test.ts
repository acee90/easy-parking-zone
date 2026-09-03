import { afterEach, describe, expect, it, vi } from 'vitest'
import { runLotSummaryBatch } from './lot-summary-batch'

const callAiText = vi.fn()
vi.mock('./lib/ai-client', () => ({
  callAiText: (...args: unknown[]) => callAiText(...args),
  parseAiJson: (text: string) => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  },
}))

interface FakeRows {
  /** SQL 조각 → 돌려줄 행 */
  [fragment: string]: unknown[]
}

/**
 * SQL 문자열의 특징적인 조각으로 응답을 고르는 최소 D1 스텁.
 * 쓰기는 전부 `writes` 에 기록한다 — stale 이 풀렸는지 보기 위해서다.
 */
function makeDb(rows: FakeRows) {
  const writes: Array<{ sql: string; args: unknown[] }> = []
  const pick = (sql: string): unknown[] => {
    for (const [fragment, value] of Object.entries(rows)) {
      if (sql.includes(fragment)) return value
    }
    return []
  }
  const db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        all: async () => ({ results: pick(sql) }),
        run: async () => {
          writes.push({ sql, args })
          return { meta: { changes: 1 } }
        },
      }),
    }),
  } as unknown as D1Database
  return { db, writes }
}

const LOT = { id: 'KA-1', name: '테스트 주차장', address: '서울시 어딘가' }
const ENV = { UNSLOTH_API_KEY: 'sk-test' }

const GOOD_SUMMARY =
  '진입로가 좁아 대형 차량은 주의가 필요합니다. 주말 오후에는 만차인 경우가 많아 이른 시간에 방문하시는 편이 낫습니다. 주차면은 비교적 넓은 편이고 기둥 간격도 여유가 있습니다. 출차 동선은 일방통행이라 한 바퀴 돌아 나와야 합니다.'

function aiResponse(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    summary: GOOD_SUMMARY,
    tip_pricing: null,
    tip_visit: null,
    tip_alternative: null,
    ...over,
  })
}

describe('runLotSummaryBatch', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('키가 없으면 아무것도 하지 않는다', async () => {
    const { db, writes } = makeDb({})
    const r = await runLotSummaryBatch(db, {})
    expect(r.picked).toBe(0)
    expect(writes).toHaveLength(0)
    expect(callAiText).not.toHaveBeenCalled()
  })

  it('생성에 성공하면 요약을 쓰면서 stale 을 내린다', async () => {
    callAiText.mockResolvedValue(aiResponse())
    const { db, writes } = makeDb({
      'ai_summary_stale = 1': [LOT],
      'FROM web_sources': [{ content: '요금은 10분 500원입니다.' }],
      'is_seed = 0': [],
      'is_seed = 1': [],
    })

    const r = await runLotSummaryBatch(db, ENV)

    expect(r.generated).toBe(1)
    expect(writes).toHaveLength(1)
    expect(writes[0].sql).toContain('INSERT INTO parking_lot_stats')
    expect(writes[0].sql).toContain('ai_summary_stale = 0')
  })

  it('근거가 하나도 없으면 만들지 않고 stale 을 내린다 — 안 그러면 매 회차 상한을 먹는다', async () => {
    const { db, writes } = makeDb({ 'ai_summary_stale = 1': [LOT] })

    const r = await runLotSummaryBatch(db, ENV)

    expect(r.noInput).toBe(1)
    expect(callAiText).not.toHaveBeenCalled()
    expect(writes[0].sql).toContain('UPDATE parking_lot_stats SET ai_summary_stale = 0')
  })

  it('이용자 후기만 있고 웹 근거가 없어도 만든다', async () => {
    callAiText.mockResolvedValue(aiResponse())
    const { db } = makeDb({
      'ai_summary_stale = 1': [LOT],
      'is_seed = 0': [
        {
          overall_score: 4,
          entry_score: 4,
          space_score: 4,
          passage_score: 4,
          exit_score: 4,
          comment: '진입이 편했습니다',
        },
      ],
    })

    const r = await runLotSummaryBatch(db, ENV)

    expect(r.generated).toBe(1)
  })

  it('품질 가드에 걸리면 저장하지 않고 stale 을 내린다 (같은 입력이면 같은 출력이다)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    callAiText.mockResolvedValue(
      aiResponse({ summary: '본 문서는 주차장 정보를 모아 제공하는 가이드입니다.'.repeat(3) }),
    )
    const { db, writes } = makeDb({
      'ai_summary_stale = 1': [LOT],
      'FROM web_sources': [{ content: '요금 정보' }],
    })

    const r = await runLotSummaryBatch(db, ENV)

    expect(r.rejected).toBe(1)
    expect(writes[0].sql).toContain('SET ai_summary_stale = 0')
  })

  it('일시적 실패면 stale 을 남겨 다음 회차가 다시 시도한다', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    callAiText.mockRejectedValue(new Error('timeout'))
    const { db, writes } = makeDb({
      'ai_summary_stale = 1': [LOT],
      'FROM web_sources': [{ content: '요금 정보' }],
    })

    const r = await runLotSummaryBatch(db, ENV)

    expect(r.failed).toBe(1)
    expect(writes).toHaveLength(0)
  })
})
