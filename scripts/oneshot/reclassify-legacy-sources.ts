/**
 * [1회성] web_sources에서 filter_passed=0 AND ai_filtered_at IS NULL인 레거시 데이터 재분류
 *
 * 컬럼 추가 시 기본값 0으로 채워진 미분류 데이터를 Haiku로 재분류.
 * - 통과 → filter_passed=1 + AI 필드 업데이트
 * - 미통과 → DELETE
 *
 * Usage:
 *   bun scripts/oneshot/reclassify-legacy-sources.ts --remote --limit 100
 *   bun scripts/oneshot/reclassify-legacy-sources.ts --remote --limit 5000
 *   bun scripts/oneshot/reclassify-legacy-sources.ts --remote --dry-run --limit 50
 */
import { d1Query } from "../lib/d1";
import { flushStatements, esc } from "../lib/sql-flush";
import { classifyBatch, type AiFilterInput, type AiFilterResult } from "../../src/server/crawlers/lib/ai-filter";
import { resolve } from "path";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 100;

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY 필요");
  process.exit(1);
}

const BATCH_SIZE = 10;
const CONCURRENCY = 3;
const DB_FLUSH_SIZE = 100;
const TMP_SQL = resolve(import.meta.dir, "../../.tmp-reclassify.sql");

interface Row {
  id: number;
  title: string;
  content: string;
  parking_lot_name: string;
}

function selectTargets(limit: number): Row[] {
  return d1Query<Row>(
    `SELECT ws.id, ws.title, ws.content, p.name as parking_lot_name
     FROM web_sources ws
     JOIN parking_lots p ON p.id = ws.parking_lot_id
     WHERE ws.filter_passed = 0 AND ws.ai_filtered_at IS NULL
     ORDER BY ws.id
     LIMIT ${limit}`,
  );
}

function buildUpdateSql(id: number, result: AiFilterResult): string {
  const keywords = esc(JSON.stringify(result.difficultyKeywords));
  const summary = esc(result.summary);
  const removedBy = result.filterRemovedBy
    ? `'${esc(result.filterRemovedBy)}'`
    : "NULL";

  return `UPDATE web_sources SET filter_passed = 1, filter_removed_by = ${removedBy}, sentiment_score = ${result.sentimentScore}, ai_difficulty_keywords = '${keywords}', ai_summary = '${summary}', ai_filtered_at = datetime('now') WHERE id = ${id};`;
}

async function main() {
  console.log(`\n🔄 레거시 web_sources 재분류 (${isDryRun ? "dry-run" : "LIVE"}, limit=${LIMIT})\n`);

  const rows = selectTargets(LIMIT);
  console.log(`  대상: ${rows.length}건\n`);
  if (rows.length === 0) {
    console.log("  처리할 항목 없음.\n");
    return;
  }

  let passed = 0;
  let removed = 0;
  let consecutiveErrors = 0;
  let pendingSql: string[] = [];
  let processed = 0;

  // 배치 청크를 CONCURRENCY개씩 병렬 처리
  const batches: Row[][] = [];
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    batches.push(rows.slice(i, i + BATCH_SIZE));
  }

  for (let i = 0; i < batches.length; i += CONCURRENCY) {
    const parallel = batches.slice(i, i + CONCURRENCY);

    const promises = parallel.map((chunk) => {
      const inputs: AiFilterInput[] = chunk.map((r) => ({
        parkingName: r.parking_lot_name,
        title: r.title ?? "",
        description: (r.content ?? "").slice(0, 200),
      }));
      return classifyBatch(inputs, API_KEY!).then((results) => ({ chunk, results }));
    });

    try {
      const settled = await Promise.allSettled(promises);

      for (const result of settled) {
        if (result.status === "rejected") {
          consecutiveErrors++;
          console.log(`  ❌ ${result.reason?.message ?? "unknown error"}`);
          continue;
        }

        consecutiveErrors = 0;
        const { chunk, results } = result.value;
        let batchPassed = 0;

        for (let j = 0; j < chunk.length; j++) {
          const row = chunk[j];
          const r = results[j] ?? {
            filterPassed: false,
            filterRemovedBy: "ai_error",
            difficultyKeywords: [],
            sentimentScore: 3.0,
            summary: "분류 실패",
          };

          if (!isDryRun) {
            if (r.filterPassed) {
              pendingSql.push(buildUpdateSql(row.id, r));
            } else {
              pendingSql.push(`DELETE FROM web_sources WHERE id = ${row.id};`);
            }
          }

          if (r.filterPassed) { passed++; batchPassed++; }
          else removed++;
        }
        processed += chunk.length;
      }

      console.log(`  [${processed}/${rows.length}] 통과 ${passed} | 제거 ${removed}`);

      if (consecutiveErrors >= 3) {
        console.error("\n  ⛔ 연속 3회 API 에러, 중단합니다.");
        break;
      }
    } catch (err) {
      console.error(`  ❌ ${(err as Error).message}`);
    }

    if (!isDryRun && pendingSql.length >= DB_FLUSH_SIZE) {
      flushStatements(TMP_SQL, pendingSql);
      pendingSql = [];
    }
  }

  if (!isDryRun && pendingSql.length > 0) {
    flushStatements(TMP_SQL, pendingSql);
  }

  console.log(`\n📊 결과`);
  console.log(`  통과 (filter_passed=1로 업데이트): ${passed}건`);
  console.log(`  제거 (DELETE): ${removed}건`);
  if (isDryRun) console.log(`  ⚠️  dry-run — DB 변경 없음`);
  console.log();
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
