/**
 * 필터 단계 대상 선정 (Workers Cron용)
 *
 * 파이프라인 재설계 (#149 v2):
 * - rule filter로 high/low만 즉시 판정, AI 호출 없음
 * - medium 항목은 filter_passed=1로 통과시켜 match 단계로 전달
 * - 실제 AI 품질 판정은 match-to-lots.ts에서 lot_name + full_text로 수행
 *
 * 2026-09-03 — 이 모듈은 **일을 하지 않고 큐에 넣기만 한다.**
 *
 * 예전에는 크론 안에서 회당 100건씩 직접 처리했다. AI 를 쓰지 않아 건당 10ms 미만인데도
 * 크론 한 호출에 여섯 단계가 묶여 있다는 이유만으로 상한이 100이었고, 유입 1,877건/일에
 * 밀려 백로그가 2,187건 쌓였다. 상한을 올리면 같은 invocation 의 매칭 단계가
 * wall time 한도에 걸린다 — 단계끼리 서로의 배치 크기를 제한하는 구조였다.
 *
 * 지금은 대상 id 만 골라 `source-filter-queue` 로 넘긴다. 실제 판정은 소비자가
 * 배치 100으로 하고, 실패는 건 단위로 격리되며 최종 실패는 DLQ 에 남는다.
 */
import { enqueueSourceFilter, processSourceFilterMessages } from '@/server/queues/source-filter'

/**
 * 한 번에 큐로 넘길 최대 건수.
 *
 * 크론이 2시간마다 도니 하루 6,000건까지 넘길 수 있다 — 유입(1,877건/일)의 3배라
 * 백로그를 따라잡고도 남는다. 이 단계의 비용은 인덱스 조회 한 번 + sendBatch 10회뿐이다.
 */
const MAX_ENQUEUE_PER_RUN = 1000

export async function runAiFilterBatch(
  db: D1Database,
  _env?: { UNSLOTH_API_KEY?: string },
): Promise<{ enqueued: number; filtered: number; passed: number; removed: number }> {
  const rows = await db
    .prepare(
      // youtube_video는 별도 검증 스크립트(scripts/verify-youtube-raw.ts)에서 처리.
      // rule-filter의 길이 임계(500자)에 영상 description은 부족 → cron 파이프라인 우회.
      `SELECT r.id
         FROM web_sources_raw r
        WHERE r.ai_filtered_at IS NULL
          AND r.full_text_status = 'ok'
          AND r.source != 'youtube_video'
        ORDER BY r.id ASC
        LIMIT ?1`,
    )
    .bind(MAX_ENQUEUE_PER_RUN)
    .all<{ id: number }>()

  const ids = (rows.results ?? []).map((r) => r.id)
  if (ids.length === 0) return { enqueued: 0, filtered: 0, passed: 0, removed: 0 }

  const { enqueued } = await enqueueSourceFilter(ids)
  if (enqueued > 0) {
    return { enqueued, filtered: 0, passed: 0, removed: 0 }
  }

  // 큐 바인딩이 없는 환경(로컬·바인딩 누락)에서는 여기서 직접 처리한다.
  // 소비자와 **같은 함수**를 쓴다 — 두 벌로 갈라지면 한쪽만 고치는 일이 반복된다.
  const INLINE_LIMIT = 100
  const r = await processSourceFilterMessages(
    db,
    ids.slice(0, INLINE_LIMIT).map((rawId) => ({ rawId })),
  )
  return { enqueued: 0, filtered: r.filtered, passed: r.passed, removed: r.removed }
}
