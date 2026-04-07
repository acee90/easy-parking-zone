/**
 * 주차장 매칭 스크립트 — filter_passed=1인 raw를 주차장에 매칭
 *
 * FTS5 검색 → scoreBlogRelevance → high 바로 저장 / medium AI 검증
 * cron(match-to-lots.ts)과 동일 로직, 로컬에서 대량 처리 가능.
 *
 * Usage:
 *   bun run scripts/match-sources.ts --remote --limit 100
 *   bun run scripts/match-sources.ts --remote --limit 1000 --no-ai  # AI 검증 스킵 (high만)
 *   bun run scripts/match-sources.ts --dry-run --limit 10
 *
 * 환경변수:
 *   ANTHROPIC_API_KEY (medium AI 검증용, --no-ai 시 불필요)
 */
import { d1Query, d1Execute, isRemote } from "./lib/d1";
import { flushStatements, esc } from "./lib/sql-flush";
import { resolve } from "path";
import {
  getMatchConfidence,
  extractNameKeywords,
  stripHtml,
} from "../src/server/crawlers/lib/scoring";
import { classifyBatch, type AiFilterInput } from "../src/server/crawlers/lib/ai-filter";

const args = process.argv.slice(2);
const isDryRun = args.includes("--dry-run");
const noAi = args.includes("--no-ai");
const limitIdx = args.indexOf("--limit");
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 100;

const API_KEY = process.env.ANTHROPIC_API_KEY;
if (!noAi && !API_KEY) {
  console.error("ANTHROPIC_API_KEY 필요 (또는 --no-ai로 high만 매칭)");
  process.exit(1);
}

const FTS_CANDIDATE_LIMIT = 20;
const BATCH_SIZE = 50; // DB flush 단위
const TMP_SQL = resolve(import.meta.dir, "../.tmp-match.sql");

const STOP_WORDS = new Set([
  "주차장", "주차", "후기", "정보", "공유", "추천", "이용", "요금",
  "무료", "저렴", "가격", "시간", "위치", "근처", "주변", "최신",
  "리스트", "포함", "안내", "방법", "꿀팁", "총정리", "비교",
  "네이버", "블로그", "카페", "유튜브", "플레이스", "리뷰",
]);

interface RawRow {
  id: number;
  source: string;
  source_id: string;
  source_url: string;
  title: string;
  content: string;
  author: string | null;
  published_at: string | null;
  sentiment_score: number | null;
  ai_difficulty_keywords: string | null;
  ai_summary: string | null;
}

interface LotRow {
  lot_id: string;
  name: string;
  address: string;
}

function selectPending(limit: number): RawRow[] {
  return d1Query<RawRow>(
    `SELECT id, source, source_id, source_url, title, content, author, published_at,
            sentiment_score, ai_difficulty_keywords, ai_summary
     FROM web_sources_raw
     WHERE filter_passed = 1 AND matched_at IS NULL
     ORDER BY id
     LIMIT ${limit}`,
  );
}

function extractSearchKeywords(title: string, content: string): string[] {
  const text = `${title} ${content}`.slice(0, 500);
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && w.length <= 15)
    .filter((w) => !STOP_WORDS.has(w))
    .filter((w) => !/^\d+$/.test(w));
  return [...new Set(words)].slice(0, 5);
}

function searchCandidates(keywords: string[]): LotRow[] {
  if (keywords.length === 0) return [];

  const results: LotRow[] = [];
  const seen = new Set<string>();

  // FTS5
  const ftsQuery = keywords.map((kw) => `"${kw}" OR ${kw}*`).join(" OR ");
  try {
    const ftsRows = d1Query<LotRow>(
      `SELECT lot_id, name, address FROM parking_lots_fts WHERE parking_lots_fts MATCH '${esc(ftsQuery)}' LIMIT ${FTS_CANDIDATE_LIMIT}`,
    );
    for (const r of ftsRows) {
      if (!seen.has(r.lot_id)) { seen.add(r.lot_id); results.push(r); }
    }
  } catch { /* FTS 실패 시 폴백 */ }

  // LIKE 폴백
  if (results.length < 3) {
    for (const kw of keywords.slice(0, 3)) {
      if (kw.length < 2) continue;
      const likeRows = d1Query<LotRow>(
        `SELECT id as lot_id, name, address FROM parking_lots WHERE name LIKE '%${esc(kw)}%' LIMIT ${FTS_CANDIDATE_LIMIT - results.length}`,
      );
      for (const r of likeRows) {
        if (!seen.has(r.lot_id)) { seen.add(r.lot_id); results.push(r); }
      }
      if (results.length >= FTS_CANDIDATE_LIMIT) break;
    }
  }

  return results;
}

function buildInsertSql(raw: RawRow, lot: LotRow, score: number): string {
  const sourceId = `${esc(raw.source_id)}:${esc(lot.lot_id)}`;
  const title = esc(stripHtml(raw.title));
  const content = esc(stripHtml(raw.content));
  const author = raw.author ? `'${esc(raw.author)}'` : "NULL";
  const publishedAt = raw.published_at ? `'${esc(raw.published_at)}'` : "NULL";
  const sentScore = raw.sentiment_score ?? "NULL";
  const kwJson = raw.ai_difficulty_keywords ? `'${esc(raw.ai_difficulty_keywords)}'` : "NULL";
  const summary = raw.ai_summary ? `'${esc(raw.ai_summary)}'` : "NULL";

  return `INSERT OR IGNORE INTO web_sources (parking_lot_id, source, source_id, title, content, source_url, author, published_at, relevance_score, raw_source_id, sentiment_score, ai_difficulty_keywords, ai_summary) VALUES ('${esc(lot.lot_id)}', '${esc(raw.source)}', '${sourceId}', '${title}', '${content}', '${esc(raw.source_url)}', ${author}, ${publishedAt}, ${score}, ${raw.id}, ${sentScore}, ${kwJson}, ${summary});`;
}

async function main() {
  console.log(`\n🔗 주차장 매칭 (${isRemote ? "remote" : "local"} DB, limit=${LIMIT}${isDryRun ? ", dry-run" : ""}${noAi ? ", no-ai" : ""})\n`);

  const sources = selectPending(LIMIT);
  console.log(`  매칭 대기: ${sources.length}건\n`);

  if (sources.length === 0) {
    console.log("  처리할 항목 없음.\n");
    return;
  }

  let matched = 0;
  let lotLinks = 0;
  let aiVerified = 0;
  let skipped = 0;
  const pendingSql: string[] = [];
  const matchedAtSql: string[] = [];

  for (let i = 0; i < sources.length; i++) {
    const raw = sources[i];
    const title = stripHtml(raw.title);
    const content = stripHtml(raw.content);
    let thisItemLinked = 0;

    const keywords = extractSearchKeywords(title, content);
    const candidates = searchCandidates(keywords);

    const highMatches: Array<{ lot: LotRow; score: number }> = [];
    const mediumMatches: Array<{ lot: LotRow; score: number }> = [];

    for (const lot of candidates) {
      const { score, confidence } = getMatchConfidence(title, content, lot.name, lot.address);
      if (confidence === "high") highMatches.push({ lot, score });
      else if (confidence === "medium") mediumMatches.push({ lot, score });
    }

    // high → 바로 저장
    for (const { lot, score } of highMatches) {
      if (!isDryRun) pendingSql.push(buildInsertSql(raw, lot, score));
      lotLinks++;
      thisItemLinked++;
    }

    // medium → AI 검증
    if (mediumMatches.length > 0 && !noAi && API_KEY) {
      const inputs: AiFilterInput[] = mediumMatches.map(({ lot }) => ({
        parkingName: lot.name,
        title,
        description: content,
      }));

      try {
        const results = await classifyBatch(inputs, API_KEY);
        for (let j = 0; j < mediumMatches.length; j++) {
          const { lot, score } = mediumMatches[j];
          if (results[j]?.filterPassed) {
            if (!isDryRun) pendingSql.push(buildInsertSql(raw, lot, score));
            lotLinks++;
            thisItemLinked++;
            aiVerified++;
          }
        }
      } catch (err) {
        console.log(`    ⚠️ AI error: ${(err as Error).message}`);
      }
    }

    // matched_at: --no-ai 모드에서 medium 후보가 남아있으면 설정 안 함 (나중에 AI로 재처리)
    const attempted = candidates.length > 0 || keywords.length > 0;
    const hasPendingMedium = noAi && mediumMatches.length > 0;
    if (attempted && !isDryRun && !hasPendingMedium) {
      matchedAtSql.push(
        `UPDATE web_sources_raw SET matched_at = datetime('now') WHERE id = ${raw.id};`,
      );
    }
    if (thisItemLinked > 0) matched++;
    else skipped++;

    // 로그
    if (thisItemLinked > 0) {
      const lots = [...highMatches.map(m => m.lot.name), ...mediumMatches.filter((_, j) => j < aiVerified).map(m => m.lot.name)];
      console.log(`  [${i + 1}/${sources.length}] ✅ ${title.slice(0, 45)} → ${thisItemLinked}건 (${lots.slice(0, 2).join(", ")})`);
    } else if ((i + 1) % 50 === 0) {
      process.stdout.write(`  [${i + 1}/${sources.length}] 처리중...\n`);
    }

    // flush
    if (!isDryRun && (pendingSql.length + matchedAtSql.length >= BATCH_SIZE)) {
      flushStatements(TMP_SQL, [...pendingSql, ...matchedAtSql]);
      pendingSql.length = 0;
      matchedAtSql.length = 0;
    }
  }

  // 남은 flush
  if (!isDryRun && (pendingSql.length + matchedAtSql.length > 0)) {
    flushStatements(TMP_SQL, [...pendingSql, ...matchedAtSql]);
  }

  console.log(`\n📊 결과`);
  console.log(`  처리: ${sources.length}건`);
  console.log(`  매칭 성공: ${matched}건 → ${lotLinks}개 주차장 링크`);
  console.log(`  AI 검증: ${aiVerified}건`);
  console.log(`  매칭 없음: ${skipped}건`);
  if (isDryRun) console.log(`  ⚠️  dry-run — DB 저장하지 않았습니다.`);
  console.log();
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
