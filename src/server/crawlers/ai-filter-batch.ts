/**
 * AI 필터링 배치 처리 (Workers Cron용)
 *
 * 미분류 web_sources_raw를 Haiku로 10건씩 배치 분류.
 * CONCURRENCY개 배치를 병렬로 처리하여 처리량 향상.
 * filter_passed / sentiment_score / ai_difficulty_keywords 등 업데이트.
 */
import { type AiFilterInput, classifyBatch } from './lib/ai-filter'

/** 1회 cron에서 처리할 최대 건수 (Free plan 30초 wall time 제한) */
const MAX_PER_RUN = 100
const BATCH_SIZE = 10
/** 동시 API 호출 수 — 10건 배치 × 5 병렬 = 50건/라운드 */
const CONCURRENCY = 5

interface UnfilteredRow {
  id: number
  title: string
  content: string
}

export async function runAiFilterBatch(
  db: D1Database,
  env: { ANTHROPIC_API_KEY: string },
): Promise<{ filtered: number; passed: number; removed: number }> {
  // 미분류 raw 소스 조회
  const rows = await db
    .prepare(
      `SELECT id, title, content
       FROM web_sources_raw
       WHERE ai_filtered_at IS NULL
       ORDER BY id ASC
       LIMIT ?1`,
    )
    .bind(MAX_PER_RUN)
    .all<UnfilteredRow>()

  const sources = rows.results ?? []
  if (sources.length === 0) return { filtered: 0, passed: 0, removed: 0 }

  let filtered = 0
  let passed = 0
  let removed = 0

  // BATCH_SIZE 단위로 청크 분할
  const chunks: UnfilteredRow[][] = []
  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    chunks.push(sources.slice(i, i + BATCH_SIZE))
  }

  // CONCURRENCY개씩 병렬 처리
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY)

    const results = await Promise.allSettled(
      batch.map(async (chunk) => {
        const inputs: AiFilterInput[] = chunk.map((s) => ({
          parkingName: '',
          title: s.title,
          description: s.content,
        }))

        const aiResults = await classifyBatch(inputs, env.ANTHROPIC_API_KEY)
        return { chunk, aiResults }
      }),
    )

    const updateBatch: D1PreparedStatement[] = []

    for (const r of results) {
      if (r.status === 'rejected') {
        console.error(`[ai-filter] batch error: ${r.reason?.message ?? r.reason}`)
        continue
      }

      const { chunk, aiResults } = r.value
      for (let j = 0; j < chunk.length; j++) {
        const source = chunk[j]
        const result = aiResults[j]
        if (!result) continue

        updateBatch.push(
          db
            .prepare(
              `UPDATE web_sources_raw SET
                filter_passed = ?1,
                filter_removed_by = ?2,
                sentiment_score = ?3,
                ai_difficulty_keywords = ?4,
                ai_summary = ?5,
                ai_filtered_at = datetime('now')
              WHERE id = ?6`,
            )
            .bind(
              result.filterPassed ? 1 : 0,
              result.filterRemovedBy,
              result.sentimentScore,
              JSON.stringify(result.difficultyKeywords),
              result.summary,
              source.id,
            ),
        )

        filtered++
        if (result.filterPassed) passed++
        else removed++
      }
    }

    if (updateBatch.length > 0) {
      await db.batch(updateBatch)
    }
  }

  return { filtered, passed, removed }
}
