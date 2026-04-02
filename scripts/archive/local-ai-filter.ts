/**
 * 덤프된 JSON을 local에서 AI 필터링 → UPDATE SQL 생성
 *
 * Usage:
 *   bun run scripts/oneshot/local-ai-filter.ts
 *
 * Input:  /tmp/unfiltered_all.json (dump-unfiltered.ts 출력)
 * Output: /tmp/ai-filter-results.sql (remote에 적용할 SQL)
 *
 * 환경변수: ANTHROPIC_API_KEY
 */
import { readFileSync, writeFileSync, appendFileSync } from "fs";
import { classifyBatch, type AiFilterInput, type AiFilterResult } from "../../src/server/crawlers/lib/ai-filter";

const INPUT = "/tmp/unfiltered_all.json";
const OUTPUT = "/tmp/ai-filter-results.sql";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY 환경변수 필요");
  process.exit(1);
}

const BATCH_SIZE = 10;
const DELAY = 300; // ms between API calls

interface Row {
  id: number;
  title: string;
  content: string;
  source_url: string;
}

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

function buildUpdateSql(id: number, r: AiFilterResult): string {
  const keywords = esc(JSON.stringify(r.difficultyKeywords));
  const summary = esc(r.summary);
  const removedBy = r.filterRemovedBy ? `'${esc(r.filterRemovedBy)}'` : "NULL";
  return `UPDATE web_sources_raw SET filter_passed=${r.filterPassed ? 1 : 0},filter_removed_by=${removedBy},sentiment_score=${r.sentimentScore},ai_difficulty_keywords='${keywords}',ai_summary='${summary}',ai_filtered_at=datetime('now') WHERE id=${id};`;
}

async function main() {
  const rows: Row[] = JSON.parse(readFileSync(INPUT, "utf-8"));
  console.log(`\n🤖 Local AI 필터링 — ${rows.length}건\n`);

  // URL 중복 제거
  const seen = new Map<string, Row>();
  const dupMap = new Map<string, number[]>();
  for (const r of rows) {
    if (!seen.has(r.source_url)) {
      seen.set(r.source_url, r);
      dupMap.set(r.source_url, []);
    } else {
      dupMap.get(r.source_url)!.push(r.id);
    }
  }
  const unique = [...seen.values()];
  const dupCount = rows.length - unique.length;
  console.log(`  고유 URL: ${unique.length}건 (중복 ${dupCount}건)\n`);

  // 출력 파일 초기화
  writeFileSync(OUTPUT, "-- AI filter results\n");

  let filtered = 0;
  let passed = 0;
  let removed = 0;
  let errors = 0;

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE);
    const inputs: AiFilterInput[] = chunk.map((s) => ({
      parkingName: "",
      title: s.title,
      description: s.content,
    }));

    process.stdout.write(`  [${i + 1}~${i + chunk.length}/${unique.length}] `);

    try {
      const results = await classifyBatch(inputs, API_KEY!);
      const passCount = results.filter((r) => r.filterPassed).length;
      console.log(`${passCount}/${chunk.length} 통과`);

      const sqlLines: string[] = [];
      for (let j = 0; j < chunk.length; j++) {
        const source = chunk[j];
        const result = results[j] ?? {
          filterPassed: false,
          filterRemovedBy: "ai_error",
          difficultyKeywords: [],
          sentimentScore: 3.0,
          summary: "분류 실패",
        };

        sqlLines.push(buildUpdateSql(source.id, result));
        filtered++;
        if (result.filterPassed) passed++;
        else removed++;

        // 중복건 동일 결과 적용
        for (const dupId of dupMap.get(source.source_url) ?? []) {
          sqlLines.push(buildUpdateSql(dupId, result));
          filtered++;
          if (result.filterPassed) passed++;
          else removed++;
        }
      }

      appendFileSync(OUTPUT, sqlLines.join("\n") + "\n");
      errors = 0;
    } catch (err) {
      errors++;
      console.log(`❌ ${(err as Error).message}`);
      if (errors >= 3) {
        console.error("\n  ⛔ 연속 3회 API 에러, 중단합니다.");
        break;
      }
    }

    if (i + BATCH_SIZE < unique.length) {
      await new Promise((r) => setTimeout(r, DELAY));
    }

    // 진행률 (100건마다)
    if (filtered % 500 < BATCH_SIZE) {
      console.log(`    📊 진행: ${filtered}/${rows.length} (통과 ${passed}, 제거 ${removed})`);
    }
  }

  console.log(`\n📊 최종 결과`);
  console.log(`  처리: ${filtered}건`);
  console.log(`  통과: ${passed}건`);
  console.log(`  제거: ${removed}건`);
  console.log(`  SQL: ${OUTPUT}`);
  console.log(`\n다음 단계: npx wrangler d1 execute parking-db --remote --file=${OUTPUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
