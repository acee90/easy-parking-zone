/**
 * AI 필터링 스크립트 — 미분류 web_sources를 Haiku로 배치 분류
 *
 * 같은 source_url은 한번만 AI 분류하고 나머지는 결과 복사 (API 비용 절감).
 * 10건씩 묶어서 Haiku 호출 → SQL도 배치로 묶어서 flush (API rate limit 방지).
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
import { resolve } from "path";
import { d1Query, isRemote } from "./lib/d1";
import { flushStatements, esc } from "./lib/sql-flush";
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
/** SQL flush 크기 (DB에 한번에 보낼 건수) */
const DB_FLUSH_SIZE = 50;
const DELAY = 500; // API rate limit

const TMP_SQL = resolve(import.meta.dir, "../.tmp-ai-filter.sql");

// ── Types ──
interface SourceRow {
  id: number;
  title: string;
  content: string;
  source_url: string;
}

// ── 미분류 소스 조회 (web_sources_raw) ──
function selectUnfiltered(limit: number): SourceRow[] {
  return d1Query<SourceRow>(
    `SELECT id, title, content, source_url
     FROM web_sources_raw
     WHERE ai_filtered_at IS NULL
     ORDER BY id DESC
     LIMIT ${limit}`,
  );
}

// ── SQL 생성 ──
function buildUpdateSql(id: number, result: AiFilterResult): string {
  const keywords = esc(JSON.stringify(result.difficultyKeywords));
  const summary = esc(result.summary);
  const removedBy = result.filterRemovedBy
    ? `'${esc(result.filterRemovedBy)}'`
    : "NULL";

  return `UPDATE web_sources_raw SET filter_passed = ${result.filterPassed ? 1 : 0}, filter_removed_by = ${removedBy}, sentiment_score = ${result.sentimentScore}, ai_difficulty_keywords = '${keywords}', ai_summary = '${summary}', ai_filtered_at = datetime('now') WHERE id = ${id};`;
}

// ── URL 중복 제거: 고유 URL만 추출 + 나머지는 결과 복사 ──
function deduplicateByUrl(sources: SourceRow[]): {
  unique: SourceRow[];
  duplicateMap: Map<string, number[]>; // url → [id, id, ...]
} {
  const seen = new Map<string, SourceRow>(); // url → first source
  const duplicateMap = new Map<string, number[]>(); // url → duplicate ids

  for (const s of sources) {
    if (!seen.has(s.source_url)) {
      seen.set(s.source_url, s);
      duplicateMap.set(s.source_url, []);
    } else {
      duplicateMap.get(s.source_url)!.push(s.id);
    }
  }

  return { unique: [...seen.values()], duplicateMap };
}

// ── Main ──
async function main() {
  console.log(`\n🤖 AI 필터링 (Haiku) — ${isRemote ? "remote" : "local"} DB, limit=${LIMIT}${isDryRun ? ", dry-run" : ""}\n`);

  const sources = selectUnfiltered(LIMIT);
  console.log(`  미분류 소스: ${sources.length}건`);

  if (sources.length === 0) {
    console.log("  모두 분류 완료.\n");
    return;
  }

  // URL 중복 제거
  const { unique, duplicateMap } = deduplicateByUrl(sources);
  const dupCount = sources.length - unique.length;
  console.log(`  고유 URL: ${unique.length}건 (중복 ${dupCount}건 → 결과 복사)\n`);

  let filtered = 0;
  let passed = 0;
  let removed = 0;
  let reused = 0;
  let errors = 0;
  let pendingSql: string[] = [];

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE);

    const inputs: AiFilterInput[] = chunk.map((s) => ({
      parkingName: "",  // raw 단계에서는 주차장 미정
      title: s.title,
      description: s.content,
    }));

    process.stdout.write(`  [${i + 1}~${i + chunk.length}/${unique.length}] `);

    try {
      const results = await classifyBatch(inputs, API_KEY!);

      const passCount = results.filter((r) => r.filterPassed).length;
      console.log(`${passCount}/${chunk.length} 통과`);

      for (let j = 0; j < chunk.length; j++) {
        const source = chunk[j];
        const result = results[j] ?? {
          filterPassed: false,
          filterRemovedBy: "ai_error",
          difficultyKeywords: [],
          sentimentScore: 3.0,
          summary: "분류 실패",
        };

        // 로그: 제목 + 요약 + 사유
        const icon = result.filterPassed ? "✅" : "❌";
        const reason = result.filterRemovedBy ? ` (${result.filterRemovedBy})` : "";
        const kw = result.difficultyKeywords.length > 0 ? ` [${result.difficultyKeywords.join(",")}]` : "";
        console.log(`    ${icon} ${source.title.slice(0, 55)} → ${result.summary}${kw}${reason}`);

        // 본인 UPDATE
        if (!isDryRun) {
          pendingSql.push(buildUpdateSql(source.id, result));
        }
        filtered++;
        if (result.filterPassed) passed++;
        else removed++;

        // 동일 URL 중복건에 결과 복사
        const dupIds = duplicateMap.get(source.source_url) ?? [];
        if (dupIds.length > 0) {
          if (!isDryRun) {
            for (const dupId of dupIds) {
              pendingSql.push(buildUpdateSql(dupId, result));
            }
          }
          reused += dupIds.length;
          filtered += dupIds.length;
          if (result.filterPassed) passed += dupIds.length;
          else removed += dupIds.length;
        }
      }

      errors = 0;
    } catch (err) {
      errors++;
      console.log(`❌ ${(err as Error).message}`);
      if (errors >= 3) {
        console.error("\n  ⛔ 연속 3회 API 에러, 중단합니다.");
        break;
      }
    }

    // SQL 배치 flush
    if (!isDryRun && pendingSql.length >= DB_FLUSH_SIZE) {
      flushStatements(TMP_SQL, pendingSql);
      pendingSql = [];
    }

    await new Promise((r) => setTimeout(r, DELAY));
  }

  // 남은 SQL flush
  if (!isDryRun && pendingSql.length > 0) {
    flushStatements(TMP_SQL, pendingSql);
  }

  console.log(`\n📊 결과`);
  console.log(`  처리: ${filtered}건 (AI 분류: ${filtered - reused}건, 결과 복사: ${reused}건)`);
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
