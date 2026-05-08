/**
 * AI 필터링 배치 처리 (Workers Cron용)
 *
 * #149: fulltext-first 파이프라인 적용.
 * 1. full_text_status='ok'인 미분류 raw만 처리
 * 2. rule filter로 high/low를 AI 없이 즉시 판정
 * 3. medium만 Haiku 호출 (fulltext 입력)
 */
import { type AiFilterInput, classifyBatch } from './lib/ai-filter'
import { classifyByRule, type RuleFilterInput } from './lib/rule-filter'

const MAX_PER_RUN = 100
const BATCH_SIZE = 10
const CONCURRENCY = 5

interface UnfilteredRow {
  id: number
  title: string
  content: string
  full_text: string | null
  full_text_status: string | null
}

export async function runAiFilterBatch(
  db: D1Database,
  env: { ANTHROPIC_API_KEY: string },
): Promise<{ filtered: number; passed: number; removed: number }> {
  // fulltext 준비된 미분류 raw만 조회
  const rows = await db
    .prepare(
      `SELECT id, title, content, full_text, full_text_status
       FROM web_sources_raw
       WHERE ai_filtered_at IS NULL
         AND full_text_status = 'ok'
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

  // rule filter 선적용: high/low는 AI 없이 즉시 처리
  const ruleBatch: D1PreparedStatement[] = []
  const mediumSources: UnfilteredRow[] = []

  for (const source of sources) {
    const ruleInput: RuleFilterInput = {
      fullText: source.full_text,
      fullTextStatus: source.full_text_status,
      title: source.title,
    }
    const tier = classifyByRule(ruleInput)

    if (tier === 'high') {
      ruleBatch.push(
        db
          .prepare(
            `UPDATE web_sources_raw SET
              filter_passed = 1,
              filter_tier = 'high',
              ai_filtered_at = datetime('now')
            WHERE id = ?1`,
          )
          .bind(source.id),
      )
      filtered++
      passed++
    } else if (tier === 'low') {
      ruleBatch.push(
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
      filtered++
      removed++
    } else {
      mediumSources.push(source)
    }
  }

  if (ruleBatch.length > 0) {
    await db.batch(ruleBatch)
  }

  if (mediumSources.length === 0) return { filtered, passed, removed }

  // medium: Haiku 배치 처리 (fulltext 입력)
  const chunks: UnfilteredRow[][] = []
  for (let i = 0; i < mediumSources.length; i += BATCH_SIZE) {
    chunks.push(mediumSources.slice(i, i + BATCH_SIZE))
  }

  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY)

    const results = await Promise.allSettled(
      batch.map(async (chunk) => {
        const inputs: AiFilterInput[] = chunk.map((s) => ({
          parkingName: '',
          title: s.title,
          description: (s.full_text ?? s.content).slice(0, 2000),
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
                filter_tier = 'medium',
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
