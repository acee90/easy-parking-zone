/**
 * AI 필터링 배치 처리 (Workers Cron용)
 *
 * 미분류 web_sources를 Haiku로 10건씩 배치 분류.
 * filter_passed / sentiment_score / ai_difficulty_keywords 등 업데이트.
 */
import { classifyBatch, type AiFilterInput } from "./lib/ai-filter";

/** 1회 cron에서 처리할 최대 건수 (10건 배치 × 5 = 50건, ~5 API 호출) */
const MAX_PER_RUN = 50;
const BATCH_SIZE = 10;

interface UnfilteredRow {
  id: number;
  parking_lot_id: string;
  title: string;
  content: string;
  parking_name: string;
}

export async function runAiFilterBatch(
  db: D1Database,
  env: { ANTHROPIC_API_KEY: string },
): Promise<{ filtered: number; passed: number; removed: number }> {
  // 미분류 소스 조회
  const rows = await db
    .prepare(
      `SELECT ws.id, ws.parking_lot_id, ws.title, ws.content,
              p.name as parking_name
       FROM web_sources ws
       JOIN parking_lots p ON p.id = ws.parking_lot_id
       WHERE ws.ai_filtered_at IS NULL
       ORDER BY ws.id DESC
       LIMIT ?1`,
    )
    .bind(MAX_PER_RUN)
    .all<UnfilteredRow>();

  const sources = rows.results ?? [];
  if (sources.length === 0) return { filtered: 0, passed: 0, removed: 0 };

  let filtered = 0;
  let passed = 0;
  let removed = 0;

  // BATCH_SIZE씩 묶어서 Haiku 호출
  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const chunk = sources.slice(i, i + BATCH_SIZE);

    const inputs: AiFilterInput[] = chunk.map((s) => ({
      parkingName: s.parking_name,
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
              `UPDATE web_sources SET
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
      break; // API 에러 시 나머지 스킵
    }
  }

  return { filtered, passed, removed };
}
