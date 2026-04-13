/**
 * Medium 신뢰도 매칭을 Anthropic Batch API로 처리하는 스크립트
 *
 * 3단계:
 *   1. collect: 전체 순회하며 medium 후보 수집 (API 호출 없이)
 *   2. submit:  수집된 건들을 Batch API로 전송
 *   3. apply:   결과 받아서 DB INSERT
 *
 * Usage:
 *   bun run scripts/match-medium-batch.ts collect          # 1단계: medium 후보 수집 → .tmp-medium.json
 *   bun run scripts/match-medium-batch.ts submit           # 2단계: Batch API 전송
 *   bun run scripts/match-medium-batch.ts status <batch_id> # 배치 상태 확인
 *   bun run scripts/match-medium-batch.ts apply <batch_id>  # 3단계: 결과 반영
 *
 * 환경변수: ANTHROPIC_API_KEY
 */
import { d1Query, d1Execute, isRemote } from "./lib/d1";
import { flushStatements, esc } from "./lib/sql-flush";
import {
  getMatchConfidence,
  extractNameKeywords,
  stripHtml,
} from "../src/server/crawlers/lib/scoring";
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";

const MEDIUM_FILE = resolve(import.meta.dir, "../.tmp-medium.json");
const FTS_CANDIDATE_LIMIT = 20;

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

interface MediumCandidate {
  raw_id: number;
  raw: RawRow;
  lot: LotRow;
  score: number;
}

const SYSTEM_PROMPT = `주차장 웹소스 매칭 검증기입니다.
주어진 블로그/카페 글이 해당 주차장에 대한 내용인지 판단합니다.

출력: JSON 객체만 (설명 없이)
{
  "is_match": true/false,
  "reason": "매칭/불일치 이유 (20자 이내)"
}

판단 기준:
- true: 해당 주차장 또는 그 주차장이 있는 시설/장소에 대한 글
- false: 다른 지역의 동명 주차장, 무관한 내용, 다른 시설의 주차 안내`;

// ── Step 1: collect ──

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

  const ftsQuery = keywords.map((kw) => `"${kw}" OR ${kw}*`).join(" OR ");
  try {
    const ftsRows = d1Query<LotRow>(
      `SELECT lot_id, name, address FROM parking_lots_fts WHERE parking_lots_fts MATCH '${esc(ftsQuery)}' LIMIT ${FTS_CANDIDATE_LIMIT}`,
    );
    for (const r of ftsRows) {
      if (!seen.has(r.lot_id)) { seen.add(r.lot_id); results.push(r); }
    }
  } catch { /* FTS 실패 시 폴백 */ }

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

function collect() {
  console.log("\n📋 Step 1: Medium 후보 수집\n");

  const sources = d1Query<RawRow>(
    "SELECT id, source, source_id, source_url, title, content, author, published_at, sentiment_score, ai_difficulty_keywords, ai_summary FROM web_sources_raw WHERE filter_passed = 1 AND matched_at IS NULL ORDER BY id",
  );
  console.log(`  대상: ${sources.length}건\n`);

  const candidates: MediumCandidate[] = [];

  for (let i = 0; i < sources.length; i++) {
    const raw = sources[i];
    const title = stripHtml(raw.title);
    const content = stripHtml(raw.content);
    const keywords = extractSearchKeywords(title, content);
    const lots = searchCandidates(keywords);

    const mediums: MediumCandidate[] = [];
    for (const lot of lots) {
      const { score, confidence } = getMatchConfidence(title, content, lot.name, lot.address);
      if (confidence === "medium") {
        mediums.push({ raw_id: raw.id, raw, lot, score });
      }
    }
    // raw당 상위 5개만
    mediums.sort((a, b) => b.score - a.score);
    candidates.push(...mediums.slice(0, 5));

    if ((i + 1) % 5000 === 0) console.log(`  ${i + 1}/${sources.length} 처리...`);
  }

  // score >= 60 필터링
  const filtered = candidates.filter(c => c.score >= 60);
  writeFileSync(MEDIUM_FILE, JSON.stringify(filtered, null, 0));
  console.log(`\n✅ Medium 후보 ${candidates.length}건 중 score>=60: ${filtered.length}건 → ${MEDIUM_FILE}`);
  console.log(`   예상 Batch API 비용: ~$${(candidates.length * 0.0003).toFixed(2)} (Haiku 50% 할인)\n`);
}

// ── Step 2: submit ──

async function submit() {
  console.log("\n🚀 Step 2: Batch API 전송\n");

  if (!existsSync(MEDIUM_FILE)) {
    console.error("  .tmp-medium.json 없음. collect 먼저 실행하세요.");
    process.exit(1);
  }

  const candidates: MediumCandidate[] = JSON.parse(readFileSync(MEDIUM_FILE, "utf-8"));
  console.log(`  후보: ${candidates.length}건`);

  const client = new Anthropic();

  const requests = candidates.map((c, i) => ({
    custom_id: `m${i}`,
    params: {
      model: "claude-haiku-4-5" as const,
      max_tokens: 200,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user" as const,
          content: `주차장: ${c.lot.name} (${c.lot.address})\n제목: ${stripHtml(c.raw.title)}\n내용: ${stripHtml(c.raw.content).slice(0, 300)}`,
        },
      ],
    },
  }));

  // Batch API 최대 100,000건
  const batch = await client.messages.batches.create({ requests });
  console.log(`\n✅ Batch 생성: ${batch.id}`);
  console.log(`   상태: ${batch.processing_status}`);
  console.log(`\n다음 단계:`);
  console.log(`   bun run scripts/match-medium-batch.ts status ${batch.id}`);
  console.log(`   bun run scripts/match-medium-batch.ts apply ${batch.id}\n`);
}

// ── Status check ──

async function status(batchId: string) {
  const client = new Anthropic();
  const batch = await client.messages.batches.retrieve(batchId);
  console.log(`\n📊 Batch ${batchId}`);
  console.log(`   상태: ${batch.processing_status}`);
  console.log(`   성공: ${batch.request_counts.succeeded}`);
  console.log(`   실패: ${batch.request_counts.errored}`);
  console.log(`   처리중: ${batch.request_counts.processing}`);
  console.log(`   만료: ${batch.request_counts.expired}\n`);
}

// ── Step 3: apply ──

async function apply(batchId: string) {
  console.log("\n📥 Step 3: 결과 반영\n");

  if (!existsSync(MEDIUM_FILE)) {
    console.error("  .tmp-medium.json 없음. collect 먼저 실행하세요.");
    process.exit(1);
  }

  const candidates: MediumCandidate[] = JSON.parse(readFileSync(MEDIUM_FILE, "utf-8"));
  const candidateMap = new Map<string, MediumCandidate>();
  for (let i = 0; i < candidates.length; i++) {
    candidateMap.set(`m${i}`, candidates[i]);
  }

  const client = new Anthropic();
  let matched = 0;
  let rejected = 0;
  let errors = 0;
  const insertSql: string[] = [];

  for await (const result of await client.messages.batches.results(batchId)) {
    const c = candidateMap.get(result.custom_id);
    if (!c) continue;

    if (result.result.type === "succeeded") {
      const text = result.result.message.content[0];
      if (text && "text" in text) {
        try {
          const m = text.text.match(/\{[\s\S]*\}/);
          if (m) {
            const parsed = JSON.parse(m[0]);
            if (parsed.is_match) {
              const raw = c.raw;
              const lot = c.lot;
              const sourceId = `${esc(raw.source_id)}:${esc(lot.lot_id)}`;
              const title = esc(stripHtml(raw.title));
              const content = esc(stripHtml(raw.content));
              const author = raw.author ? `'${esc(raw.author)}'` : "NULL";
              const publishedAt = raw.published_at ? `'${esc(raw.published_at)}'` : "NULL";
              const sentScore = raw.sentiment_score ?? "NULL";
              const kwJson = raw.ai_difficulty_keywords ? `'${esc(raw.ai_difficulty_keywords)}'` : "NULL";
              const summary = raw.ai_summary ? `'${esc(raw.ai_summary)}'` : "NULL";

              insertSql.push(
                `INSERT OR IGNORE INTO web_sources (parking_lot_id, source, source_id, title, content, source_url, author, published_at, relevance_score, raw_source_id, sentiment_score, ai_difficulty_keywords, ai_summary) VALUES ('${esc(lot.lot_id)}', '${esc(raw.source)}', '${sourceId}', '${title}', '${content}', '${esc(raw.source_url)}', ${author}, ${publishedAt}, ${c.score}, ${raw.id}, ${sentScore}, ${kwJson}, ${summary});`
              );
              matched++;
            } else {
              rejected++;
            }
          }
        } catch {
          errors++;
        }
      }
    } else {
      errors++;
    }
  }

  console.log(`  AI 검증 결과: 매칭 ${matched}건 / 거부 ${rejected}건 / 에러 ${errors}건`);

  if (insertSql.length > 0) {
    console.log(`  DB INSERT ${insertSql.length}건...`);
    flushStatements(resolve(import.meta.dir, "../.tmp-apply.sql"), insertSql);

    // matched_at 업데이트
    const rawIds = [...new Set(candidates.map(c => c.raw_id))];
    const idChunks: number[][] = [];
    for (let i = 0; i < rawIds.length; i += 500) {
      idChunks.push(rawIds.slice(i, i + 500));
    }
    for (const chunk of idChunks) {
      d1Execute(`UPDATE web_sources_raw SET matched_at = datetime('now') WHERE id IN (${chunk.join(",")});`);
    }
    console.log(`  matched_at 업데이트: ${rawIds.length}건`);
  }

  console.log(`\n✅ 완료. web_sources에 ${matched}건 추가됨.\n`);
}

// ── Main ──

const command = process.argv[2];
const arg = process.argv[3];

switch (command) {
  case "collect":
    collect();
    break;
  case "submit":
    await submit();
    break;
  case "status":
    if (!arg) { console.error("batch_id 필요"); process.exit(1); }
    await status(arg);
    break;
  case "apply":
    if (!arg) { console.error("batch_id 필요"); process.exit(1); }
    await apply(arg);
    break;
  default:
    console.log("Usage: bun run scripts/match-medium-batch.ts <collect|submit|status|apply> [batch_id]");
}
