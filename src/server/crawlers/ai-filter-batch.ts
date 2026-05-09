/**
 * AI 필터링 배치 처리 (Workers Cron용)
 *
 * 파이프라인 재설계 (#149 v2):
 * - rule filter로 high/low만 즉시 판정, AI 호출 없음
 * - medium 항목은 filter_passed=1로 통과시켜 match 단계로 전달
 * - 실제 AI 품질 판정은 match-to-lots.ts에서 lot_name + full_text로 수행
 */
import { classifyByRule, type RuleFilterInput } from './lib/rule-filter'

const MAX_PER_RUN = 100

interface UnfilteredRow {
  id: number
  title: string
  content: string
  full_text: string | null
  full_text_status: string | null
}

export async function runAiFilterBatch(
  db: D1Database,
  env?: { ANTHROPIC_API_KEY?: string },
): Promise<{ filtered: number; passed: number; removed: number }> {
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

  const updateBatch: D1PreparedStatement[] = []

  for (const source of sources) {
    const ruleInput: RuleFilterInput = {
      fullText: source.full_text,
      fullTextStatus: source.full_text_status,
      title: source.title,
    }
    const tier = classifyByRule(ruleInput)

    if (tier === 'low') {
      updateBatch.push(
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
      removed++
    } else {
      // high 또는 medium: match 단계에서 lot_name + full_text로 AI 판정
      updateBatch.push(
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
      passed++
    }
    filtered++
  }

  if (updateBatch.length > 0) {
    await db.batch(updateBatch)
  }

  return { filtered, passed, removed }
}
