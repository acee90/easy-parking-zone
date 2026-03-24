/**
 * AI 필터링 스크립트 — 미분류 web_sources를 Haiku로 배치 분류
 *
 * cron 크롤링 후 후처리로 실행. filter_passed / sentiment_score 등을 업데이트.
 * 10건씩 묶어서 Haiku 호출 → API 비용 절감.
 *
 * Usage:
 *   bun run scripts/ai-filter-sources.ts                    # 로컬 DB, 100건
 *   bun run scripts/ai-filter-sources.ts --remote            # 리모트 D1
 *   bun run scripts/ai-filter-sources.ts --remote --limit 500
 *   bun run scripts/ai-filter-sources.ts --dry-run            # API만 호출, DB 저장 안함
 *
 * 환경변수:
 *   ANTHROPIC_API_KEY (필수)
 */
import { d1Query, d1Execute, isRemote } from "./lib/d1";
import { classifyBatch, type AiFilterInput, type AiFilterResult } from "../src/server/crawlers/lib/ai-filter";

// ── CLI 옵션 ──
const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 100;

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

/** Haiku 배치 크기 (한 번에 분류할 건수) */
const BATCH_SIZE = 10;
const DELAY = 500; // API rate limit

// ── Types ──
interface SourceRow {
  id: number;
  parking_lot_id: string;
  title: string;
  content: string;
  source_url: string;
  parking_name: string;
}

// ── 미분류 소스 조회 ──
function selectUnfiltered(limit: number): SourceRow[] {
  return d1Query<SourceRow>(
    `SELECT ws.id, ws.parking_lot_id, ws.title, ws.content, ws.source_url,
            p.name as parking_name
     FROM web_sources ws
     JOIN parking_lots p ON p.id = ws.parking_lot_id
     WHERE ws.ai_filtered_at IS NULL
     ORDER BY ws.id DESC
     LIMIT ${limit}`,
  );
}

// ── DB 업데이트 ──
function updateSource(id: number, result: AiFilterResult): void {
  const keywords = JSON.stringify(result.difficultyKeywords).replace(/'/g, "''");
  const summary = result.summary.replace(/'/g, "''");
  const removedBy = result.filterRemovedBy
    ? `'${result.filterRemovedBy.replace(/'/g, "''")}'`
    : "NULL";

  d1Execute(
    `UPDATE web_sources SET
       filter_passed = ${result.filterPassed ? 1 : 0},
       filter_removed_by = ${removedBy},
       sentiment_score = ${result.sentimentScore},
       ai_difficulty_keywords = '${keywords}',
       ai_summary = '${summary}',
       ai_filtered_at = datetime('now')
     WHERE id = ${id}`,
  );
}

// ── Main ──
async function main() {
  console.log(`\n🤖 AI 필터링 (Haiku) — ${isRemote ? "remote" : "local"} DB, limit=${LIMIT}${isDryRun ? ", dry-run" : ""}\n`);

  const sources = selectUnfiltered(LIMIT);
  console.log(`  미분류 소스: ${sources.length}건\n`);

  if (sources.length === 0) {
    console.log("  모두 분류 완료.\n");
    return;
  }

  let filtered = 0;
  let passed = 0;
  let removed = 0;
  let errors = 0;

  // BATCH_SIZE씩 묶어서 처리
  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const chunk = sources.slice(i, i + BATCH_SIZE);

    const inputs: AiFilterInput[] = chunk.map((s) => ({
      parkingName: s.parking_name,
      title: s.title,
      description: s.content,
    }));

    process.stdout.write(`  [${i + 1}~${i + chunk.length}/${sources.length}] `);

    try {
      const results = await classifyBatch(inputs, API_KEY!);

      for (let j = 0; j < chunk.length; j++) {
        const source = chunk[j];
        const result = results[j] ?? {
          filterPassed: false,
          filterRemovedBy: "ai_error",
          difficultyKeywords: [],
          sentimentScore: 3.0,
          summary: "분류 실패",
        };

        if (isDryRun) {
          const icon = result.filterPassed ? "✅" : "❌";
          const kw = result.difficultyKeywords.length > 0
            ? ` [${result.difficultyKeywords.join(",")}]`
            : "";
          console.log(
            `    ${icon} ${source.title.slice(0, 50)} → ${result.summary}${kw} (${result.sentimentScore}점)`,
          );
        } else {
          updateSource(source.id, result);
        }

        filtered++;
        if (result.filterPassed) passed++;
        else removed++;
      }

      if (!isDryRun) {
        const passCount = results.filter((r) => r.filterPassed).length;
        console.log(`${passCount}/${chunk.length} 통과`);
      }
    } catch (err) {
      errors++;
      console.log(`❌ ${(err as Error).message}`);
      if (errors >= 3) {
        console.error("\n  ⛔ 연속 3회 API 에러, 중단합니다.");
        break;
      }
    }

    await new Promise((r) => setTimeout(r, DELAY));
  }

  console.log(`\n📊 결과`);
  console.log(`  처리: ${filtered}건`);
  console.log(`  통과: ${passed}건 (주차 후기)`);
  console.log(`  제거: ${removed}건 (광고/무관)`);
  if (errors > 0) console.log(`  에러: ${errors}건`);
  if (isDryRun) console.log(`  ⚠️  dry-run — DB 저장하지 않았습니다.`);
  console.log();
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
