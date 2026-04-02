/**
 * 덤프된 JSON을 local에서 AI 필터링 (병렬) → UPDATE SQL 생성
 *
 * Usage:
 *   bun run scripts/oneshot/local-ai-filter-parallel.ts
 *   bun run scripts/oneshot/local-ai-filter-parallel.ts --skip-ids /tmp/ai-filter-results.sql
 *
 * Input:  /tmp/unfiltered_all.json
 * Output: /tmp/ai-filter-results-parallel.sql
 *
 * 환경변수: ANTHROPIC_API_KEY
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "fs";
import { classifyBatch, type AiFilterInput, type AiFilterResult } from "../../src/server/crawlers/lib/ai-filter";

const INPUT = "/tmp/unfiltered_all.json";
const OUTPUT = "/tmp/ai-filter-results-parallel.sql";

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!API_KEY) {
  console.error("ANTHROPIC_API_KEY 환경변수 필요");
  process.exit(1);
}

/** API 동시 호출 수 (Anthropic rate limit: Haiku ~100 RPM) */
const CONCURRENCY = 5;
const BATCH_SIZE = 10;

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

async function processBatch(
  chunk: Row[],
  dupMap: Map<string, number[]>,
): Promise<{ sql: string[]; passed: number; removed: number; count: number }> {
  const inputs: AiFilterInput[] = chunk.map((s) => ({
    parkingName: "",
    title: s.title,
    description: s.content,
  }));

  const results = await classifyBatch(inputs, API_KEY!);

  const sql: string[] = [];
  let passed = 0;
  let removed = 0;
  let count = 0;

  for (let j = 0; j < chunk.length; j++) {
    const source = chunk[j];
    const result = results[j] ?? {
      filterPassed: false,
      filterRemovedBy: "ai_error",
      difficultyKeywords: [],
      sentimentScore: 3.0,
      summary: "분류 실패",
    };

    sql.push(buildUpdateSql(source.id, result));
    count++;
    if (result.filterPassed) passed++;
    else removed++;

    for (const dupId of dupMap.get(source.source_url) ?? []) {
      sql.push(buildUpdateSql(dupId, result));
      count++;
      if (result.filterPassed) passed++;
      else removed++;
    }
  }

  return { sql, passed, removed, count };
}

async function main() {
  const allRows: Row[] = JSON.parse(readFileSync(INPUT, "utf-8"));

  // 이전 결과에서 이미 처리된 ID 건너뛰기
  const skipIds = new Set<number>();
  const skipArg = process.argv.indexOf("--skip-ids");
  if (skipArg >= 0) {
    const prevFile = process.argv[skipArg + 1];
    if (existsSync(prevFile)) {
      const content = readFileSync(prevFile, "utf-8");
      for (const m of content.matchAll(/WHERE id=(\d+)/g)) {
        skipIds.add(parseInt(m[1]));
      }
      console.log(`  이전 결과에서 ${skipIds.size}건 건너뜀`);
    }
  }

  const rows = allRows.filter((r) => !skipIds.has(r.id));

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

  console.log(`\n🤖 병렬 AI 필터링 — ${rows.length}건 (고유 ${unique.length}건, 동시 ${CONCURRENCY}개)\n`);

  writeFileSync(OUTPUT, "-- AI filter results (parallel)\n");

  let totalProcessed = 0;
  let totalPassed = 0;
  let totalRemoved = 0;
  let errors = 0;
  const startTime = Date.now();

  // BATCH_SIZE 단위로 청크 생성
  const chunks: Row[][] = [];
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    chunks.push(unique.slice(i, i + BATCH_SIZE));
  }

  // CONCURRENCY개씩 병렬 처리
  for (let i = 0; i < chunks.length; i += CONCURRENCY) {
    const batch = chunks.slice(i, i + CONCURRENCY);

    const results = await Promise.allSettled(
      batch.map((chunk) => processBatch(chunk, dupMap)),
    );

    const sqlLines: string[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") {
        sqlLines.push(...r.value.sql);
        totalProcessed += r.value.count;
        totalPassed += r.value.passed;
        totalRemoved += r.value.removed;
        errors = 0;
      } else {
        errors++;
        console.error(`  ❌ ${r.reason?.message ?? r.reason}`);
        if (errors >= 5) {
          console.error("\n  ⛔ 연속 에러, 중단");
          break;
        }
      }
    }

    if (sqlLines.length > 0) {
      appendFileSync(OUTPUT, sqlLines.join("\n") + "\n");
    }

    if (errors >= 5) break;

    // 진행률 (매 CONCURRENCY 라운드마다)
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const chunkIdx = Math.min(i + CONCURRENCY, chunks.length);
    const rate = totalProcessed / (Number(elapsed) || 1);
    const remaining = ((rows.length - totalProcessed) / rate).toFixed(0);
    console.log(
      `  [${chunkIdx}/${chunks.length} batches] ${totalProcessed}/${rows.length}건 (통과 ${totalPassed}, 제거 ${totalRemoved}) — ${elapsed}s elapsed, ~${remaining}s left`,
    );
  }

  console.log(`\n📊 최종 결과`);
  console.log(`  처리: ${totalProcessed}건`);
  console.log(`  통과: ${totalPassed}건`);
  console.log(`  제거: ${totalRemoved}건`);
  console.log(`  소요: ${((Date.now() - startTime) / 1000 / 60).toFixed(1)}분`);
  console.log(`  SQL: ${OUTPUT}`);
  console.log(`\n다음 단계:`);
  console.log(`  1. cat /tmp/ai-filter-results.sql ${OUTPUT} > /tmp/ai-filter-combined.sql`);
  console.log(`  2. npx wrangler d1 execute parking-db --remote --file=/tmp/ai-filter-combined.sql`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
