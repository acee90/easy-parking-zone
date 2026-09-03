/**
 * 필터 단계 큐 — raw 1건 = 메시지 1건
 *
 * 왜 큐인가:
 *   이 단계는 AI 를 쓰지 않고 건당 10ms 미만인데, 크론 안에 있다는 이유만으로
 *   회당 100건에 묶여 있었다. 유입은 하루 1,877건이라 백로그가 2,187건 쌓였다
 *   (2026-09-03 실측). 소비자로 옮기면 배치 100 × 자동 확장으로 상한이 사라진다.
 *
 * 메시지 단위를 1건으로 두는 이유:
 *   묶어서 보내면 1건이 실패할 때 묶음 전체가 재시도된다. 그게 크론의 문제였고
 *   큐로 옮기는 이유다. 배치는 `max_batch_size` 가 대신 해 준다 — 소비자는
 *   메시지 100개를 **한 번의 invocation** 으로 받아 몇 번의 쿼리로 처리한다.
 *   비용도 이유가 안 된다: 월 36만 작업으로 무료 한도(100만) 안이다.
 *
 * 멱등성:
 *   at-least-once 라 같은 메시지가 두 번 온다. `ai_filtered_at IS NULL` 을
 *   SELECT 조건에 두어 이미 처리된 행은 조회 자체가 안 되게 한다.
 *
 * 재생산 차단:
 *   `max_retries` 는 **메시지**를 제한하지 재생산을 막지 못한다. 생산자 조회 조건이
 *   `ai_filtered_at IS NULL` 이라, 계속 실패하는 행은 DLQ 로 간 뒤에도 두 시간마다
 *   다시 큐에 들어간다 — 영구 루프다. 그래서 마지막 시도에서 실패한 행은
 *   `consumer_error` 로 종결 표시해 생산자 대상에서 빼낸다.
 */

import { env } from 'cloudflare:workers'
import { isAggregatorUrl } from '@/server/crawlers/lib/aggregator-domains'
import { classifyByRule, type RuleFilterInput } from '@/server/crawlers/lib/rule-filter'

export interface SourceFilterMessage {
  rawId: number
}

export interface SourceFilterResult {
  /** 메시지로 받은 건수 */
  requested: number
  /** 실제로 처리한 건수 (이미 처리된 행은 빠진다) */
  filtered: number
  passed: number
  removed: number
}

function getQueue(): Queue<SourceFilterMessage> | undefined {
  return (env as unknown as { SOURCE_FILTER_QUEUE?: Queue<SourceFilterMessage> })
    .SOURCE_FILTER_QUEUE
}

/** sendBatch 한 번에 담을 수 있는 최대치 */
const QUEUE_SEND_BATCH_LIMIT = 100

export async function enqueueSourceFilter(
  rawIds: readonly number[],
): Promise<{ enqueued: number }> {
  if (rawIds.length === 0) return { enqueued: 0 }
  const queue = getQueue()
  if (!queue) return { enqueued: 0 }

  let enqueued = 0
  for (let i = 0; i < rawIds.length; i += QUEUE_SEND_BATCH_LIMIT) {
    const chunk = rawIds.slice(i, i + QUEUE_SEND_BATCH_LIMIT)
    try {
      await queue.sendBatch(chunk.map((rawId) => ({ body: { rawId } })))
      enqueued += chunk.length
    } catch (err) {
      console.error('[source-filter-queue] sendBatch failed', chunk.length, err)
    }
  }
  return { enqueued }
}

interface UnfilteredRow {
  id: number
  title: string
  source_url: string | null
  full_text: string | null
  full_text_status: string | null
}

/**
 * 이 횟수째 배달에서도 실패하면 행을 종결 처리한다.
 * `max_retries: 3` 이라 배달은 최대 4회다 — DLQ 로 넘어가기 전에 손을 쓴다.
 */
export const TERMINAL_ATTEMPT = 3

/**
 * 계속 실패하는 행을 생산자 대상에서 빼낸다.
 * 값은 지우지 않는다 — 왜 빠졌는지 `filter_removed_by` 에 남긴다.
 */
export async function markSourceFilterTerminal(
  db: D1Database,
  rawIds: readonly number[],
): Promise<number> {
  if (rawIds.length === 0) return 0
  const updates = rawIds.map((id) =>
    db
      .prepare(
        `UPDATE web_sources_raw SET
           filter_passed = 0,
           filter_removed_by = 'consumer_error',
           filter_tier = 'low',
           ai_filtered_at = datetime('now')
         WHERE id = ?1 AND ai_filtered_at IS NULL`,
      )
      .bind(id),
  )
  await db.batch(updates)
  return updates.length
}

/**
 * D1 은 쿼리 하나에 바인딩 파라미터를 **100개까지만** 받는다.
 * `max_batch_size` 가 100 이라 `IN (...)` 을 그대로 쓰면 정확히 한계에 걸터앉는다.
 * 여유를 두고 잘라 조회한다 — 나중에 이 쿼리에 조건 하나만 더 붙어도 터질 자리다.
 */
const ID_CHUNK = 90

/**
 * 소비자 본체.
 *
 * 메시지가 100건이어도 **쿼리는 서너 번**이다 — 조회 2회(90건씩), 쓰기 1회(db.batch).
 * 건별로 왕복하면 D1 rows_read 가 그만큼 늘어난다. 크론 주기까지 늘려 아껴온 자원이다.
 */
export async function processSourceFilterMessages(
  db: D1Database,
  messages: readonly SourceFilterMessage[],
): Promise<SourceFilterResult> {
  const ids = [
    ...new Set(
      messages.map((m) => m.rawId).filter((id) => typeof id === 'number' && Number.isFinite(id)),
    ),
  ]
  const result: SourceFilterResult = {
    requested: ids.length,
    filtered: 0,
    passed: 0,
    removed: 0,
  }
  if (ids.length === 0) return result

  const sources: UnfilteredRow[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const placeholders = chunk.map((_, j) => `?${j + 1}`).join(',')
    const rows = await db
      .prepare(
        // 본문은 web_sources_raw_body에 분리 저장 (0048) — JOIN으로 조회한다.
        //
        // `ai_filtered_at IS NULL` 이 멱등성 장치다. 중복 배달된 메시지는 여기서 걸러진다.
        // youtube_video 는 별도 검증 스크립트가 맡는다 (rule-filter 길이 임계에 못 미친다).
        `SELECT r.id, r.title, r.source_url, b.body AS full_text, r.full_text_status
           FROM web_sources_raw r
           LEFT JOIN web_sources_raw_body b ON b.raw_id = r.id
          WHERE r.id IN (${placeholders})
            AND r.ai_filtered_at IS NULL
            AND r.full_text_status = 'ok'
            AND r.source != 'youtube_video'`,
      )
      .bind(...chunk)
      .all<UnfilteredRow>()
    sources.push(...(rows.results ?? []))
  }

  if (sources.length === 0) return result

  const updates: D1PreparedStatement[] = []
  for (const source of sources) {
    // 정보 모음 사이트(경쟁 애그리게이터)는 본문 길이·문체와 무관하게 즉시 제거한다.
    // 후기가 아니라 우리와 같은 공공데이터의 재배포이고, 집계에 섞이면 요약·평점이 오염된다.
    if (isAggregatorUrl(source.source_url)) {
      updates.push(
        db
          .prepare(
            `UPDATE web_sources_raw SET
               filter_passed = 0,
               filter_removed_by = 'aggregator_site',
               filter_tier = 'low',
               ai_filtered_at = datetime('now')
             WHERE id = ?1`,
          )
          .bind(source.id),
      )
      result.removed++
      result.filtered++
      continue
    }

    const ruleInput: RuleFilterInput = {
      fullText: source.full_text,
      fullTextStatus: source.full_text_status,
      title: source.title,
    }
    const tier = classifyByRule(ruleInput)

    if (tier === 'low') {
      updates.push(
        db
          .prepare(
            `UPDATE web_sources_raw SET
               filter_passed = 0,
               filter_removed_by = 'rule_low',
               filter_tier = 'low',
               ai_filtered_at = datetime('now')
             WHERE id = ?1`,
          )
          .bind(source.id),
      )
      result.removed++
    } else {
      // high 또는 medium: match 단계에서 lot_name + full_text로 AI 판정
      updates.push(
        db
          .prepare(
            `UPDATE web_sources_raw SET
               filter_passed = 1,
               filter_tier = ?1,
               ai_filtered_at = datetime('now')
             WHERE id = ?2`,
          )
          .bind(tier, source.id),
      )
      result.passed++
    }
    result.filtered++
  }

  if (updates.length > 0) await db.batch(updates)
  return result
}
