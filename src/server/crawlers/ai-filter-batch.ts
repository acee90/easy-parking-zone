/**
 * AI 필터링 배치 처리 (Workers Cron용)
 *
 * 미분류 web_sources_raw를 Haiku로 10건씩 배치 분류.
 * filter_passed / sentiment_score / ai_difficulty_keywords 등 업데이트.
 */
import { classifyBatch, type AiFilterInput } from "./lib/ai-filter";

/** 1회 cron에서 처리할 최대 건수 (10건 배치 × 5 = 50건, ~5 API 호출) */
const MAX_PER_RUN = 50;
const BATCH_SIZE = 10;

interface UnfilteredRow {
  id: number;
  title: string;
  content: string;
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
       ORDER BY id DESC
       LIMIT ?1`,
    )
    .bind(MAX_PER_RUN)
    .all<UnfilteredRow>();

  const sources = rows.results ?? [];
  if (sources.length === 0) return { filtered: 0, passed: 0, removed: 0 };

  let filtered = 0;
  let passed = 0;
  let removed = 0;

  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const chunk = sources.slice(i, i + BATCH_SIZE);

    const inputs: AiFilterInput[] = chunk.map((s) => ({
      parkingName: "", // raw 단계에서는 주차장 미정
      title: s.title,
      description: s.content,
    }));

    try {
      const results = await classifyBatch(inputs, env.ANTHROPIC_API_KEY);

      const updateBatch: D1PreparedStatement[] = [];

      for (let j = 0; j < chunk.length; j++) {
        const source = chunk[j];
        const result = results[j];
        if (!result) continue;

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
        );

        filtered++;
        if (result.filterPassed) passed++;
        else removed++;
      }

      if (updateBatch.length > 0) {
        await db.batch(updateBatch);
      }
    } catch (err) {
      console.error(`[ai-filter] batch error: ${(err as Error).message}`);
      break;
    }
  }

  return { filtered, passed, removed };
}
