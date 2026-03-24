/**
 * 기존 web_sources → web_sources_raw 마이그레이션
 *
 * URL 기준 dedup하여 raw 테이블에 삽입.
 * web_sources.raw_source_id를 역참조로 연결.
 *
 * Usage:
 *   bun run scripts/migrate-to-raw.ts --remote [--dry-run]
 */
import { d1Query, d1Execute, d1ExecFile, isRemote } from "./lib/d1";
import { writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";

const isDryRun = process.argv.includes("--dry-run");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-migrate-raw.sql");
const BATCH_SIZE = 200;

console.log(`\n📦 web_sources → web_sources_raw 마이그레이션 (${isRemote ? "remote" : "local"}${isDryRun ? ", dry-run" : ""})\n`);

// 1. 고유 URL 수 확인
const [{ total, unique_urls }] = d1Query<{ total: number; unique_urls: number }>(
  "SELECT COUNT(*) as total, COUNT(DISTINCT source_url) as unique_urls FROM web_sources",
);
console.log(`  기존: ${total}건, 고유 URL: ${unique_urls}건 (중복 ${total - unique_urls}건)\n`);

// 2. raw에 이미 있는 건 확인
const [{ raw_count }] = d1Query<{ raw_count: number }>(
  "SELECT COUNT(*) as raw_count FROM web_sources_raw",
);
console.log(`  raw 테이블 기존: ${raw_count}건\n`);

if (isDryRun) {
  console.log("  ⚠️  dry-run 모드 — 실제 삽입하지 않습니다.\n");
  process.exit(0);
}

// 3. URL 단위로 dedup하여 raw에 삽입 (가장 높은 relevance_score 행을 대표로)
console.log("  Step 1: web_sources_raw INSERT (URL dedup)...");
d1Execute(`
  INSERT OR IGNORE INTO web_sources_raw
    (source, source_id, source_url, title, content, author, published_at, crawled_at,
     filter_passed, filter_removed_by, sentiment_score, ai_difficulty_keywords, ai_summary, ai_filtered_at)
  SELECT source, source_id, source_url, title, content, author, published_at, crawled_at,
         filter_passed, filter_removed_by, sentiment_score, ai_difficulty_keywords, ai_summary, ai_filtered_at
  FROM web_sources
  WHERE id IN (
    SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY source_url ORDER BY relevance_score DESC, id) as rn
      FROM web_sources
    ) WHERE rn = 1
  )
`);

const [{ new_raw }] = d1Query<{ new_raw: number }>(
  "SELECT COUNT(*) as new_raw FROM web_sources_raw",
);
console.log(`  → raw 테이블: ${new_raw}건\n`);

// 4. web_sources.raw_source_id 역참조 연결
console.log("  Step 2: web_sources.raw_source_id 연결...");
d1Execute(`
  UPDATE web_sources SET raw_source_id = (
    SELECT r.id FROM web_sources_raw r
    WHERE r.source_url = web_sources.source_url
    LIMIT 1
  )
  WHERE raw_source_id IS NULL
`);

const [{ linked }] = d1Query<{ linked: number }>(
  "SELECT COUNT(*) as linked FROM web_sources WHERE raw_source_id IS NOT NULL",
);
console.log(`  → ${linked}/${total}건 연결 완료\n`);

console.log("✅ 마이그레이션 완료\n");
