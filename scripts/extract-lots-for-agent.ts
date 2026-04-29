/**
 * parking-lot-summary-generator 에이전트용 입력 JSON 추출
 *
 * 출력 스키마 (agent 입력 포맷):
 *   { id, name, address, web_summaries: string[], reviews: string[] }
 *
 * Usage:
 *   bun run scripts/extract-lots-for-agent.ts --remote --limit=3
 *   bun run scripts/extract-lots-for-agent.ts --remote --limit=3 --mixed
 *   bun run scripts/extract-lots-for-agent.ts --remote --limit=100 --output=data/lots_for_summary.json
 *
 * --mixed: rich / thin / review-only 한 건씩 의도적으로 섞어서 추출 (limit 무시, 3건 고정)
 */
import { d1Query } from "./lib/d1";
import { esc } from "./lib/sql-flush";
import { writeFileSync } from "fs";

interface LotRow {
  id: string;
  name: string;
  address: string;
}

interface AgentInput {
  id: string;
  name: string;
  address: string;
  web_summaries: string[];
  reviews: string[];
}

const args = process.argv.slice(2);
const limit = parseInt(
  args.find((a) => a.startsWith("--limit="))?.split("=")[1] ?? "20",
  10,
);
const isMixed = args.includes("--mixed");
const output =
  args.find((a) => a.startsWith("--output="))?.split("=")[1] ??
  "data/lots_for_summary.json";

interface WebRow {
  parking_lot_id: string;
  content: string;
}
interface ReviewBulkRow {
  parking_lot_id: string;
  overall_score: number;
  entry_score: number;
  space_score: number;
  passage_score: number;
  exit_score: number;
  comment: string | null;
}

function fetchAllWebSummaries(lotIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (lotIds.length === 0) return map;
  const idList = lotIds.map((id) => `'${esc(id)}'`).join(",");
  const rows = d1Query<WebRow>(`
    SELECT parking_lot_id, ai_summary AS content
    FROM web_sources
    WHERE parking_lot_id IN (${idList})
      AND ai_summary IS NOT NULL AND ai_summary != ''
    ORDER BY parking_lot_id, relevance_score DESC
  `);
  for (const r of rows) {
    const arr = map.get(r.parking_lot_id) ?? [];
    if (arr.length < 30) arr.push(r.content);
    map.set(r.parking_lot_id, arr);
  }
  return map;
}

function fetchAllReviews(lotIds: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (lotIds.length === 0) return map;
  const idList = lotIds.map((id) => `'${esc(id)}'`).join(",");
  const rows = d1Query<ReviewBulkRow>(`
    SELECT parking_lot_id, overall_score, entry_score, space_score, passage_score, exit_score, comment
    FROM user_reviews
    WHERE parking_lot_id IN (${idList})
    ORDER BY parking_lot_id, created_at DESC
  `);
  for (const r of rows) {
    const arr = map.get(r.parking_lot_id) ?? [];
    if (arr.length >= 30) continue;
    const c = r.comment ? `"${r.comment.slice(0, 200)}"` : "(코멘트 없음)";
    arr.push(
      `[R${arr.length + 1}] 종합 ${r.overall_score}/5 · 진입 ${r.entry_score} · 주차면 ${r.space_score} · 통로 ${r.passage_score} · 출차 ${r.exit_score} — ${c}`,
    );
    map.set(r.parking_lot_id, arr);
  }
  return map;
}

function pickMixed(): LotRow[] {
  // rich: web_summaries ≥ 10건
  const rich = d1Query<LotRow>(`
    SELECT p.id, p.name, p.address
    FROM parking_lots p
    LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
    WHERE (s.ai_summary IS NULL OR s.ai_summary = '')
      AND (SELECT COUNT(*) FROM web_sources w
           WHERE w.parking_lot_id = p.id
             AND w.ai_summary IS NOT NULL AND w.ai_summary != '') >= 10
    ORDER BY COALESCE(s.final_score, 0) DESC
    LIMIT 1
  `);

  // thin: web_summaries 1~3건, reviews 0건
  const thin = d1Query<LotRow>(`
    SELECT p.id, p.name, p.address
    FROM parking_lots p
    LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
    WHERE (s.ai_summary IS NULL OR s.ai_summary = '')
      AND (SELECT COUNT(*) FROM web_sources w
           WHERE w.parking_lot_id = p.id
             AND w.ai_summary IS NOT NULL AND w.ai_summary != '') BETWEEN 1 AND 3
      AND (SELECT COUNT(*) FROM user_reviews r WHERE r.parking_lot_id = p.id) = 0
    LIMIT 1
  `);

  // review-only: web_summaries 0건, reviews ≥ 1건
  const reviewOnly = d1Query<LotRow>(`
    SELECT p.id, p.name, p.address
    FROM parking_lots p
    LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
    WHERE (s.ai_summary IS NULL OR s.ai_summary = '')
      AND (SELECT COUNT(*) FROM web_sources w
           WHERE w.parking_lot_id = p.id
             AND w.ai_summary IS NOT NULL AND w.ai_summary != '') = 0
      AND (SELECT COUNT(*) FROM user_reviews r WHERE r.parking_lot_id = p.id) >= 1
    LIMIT 1
  `);

  return [...rich, ...thin, ...reviewOnly];
}

function pickDefault(n: number): LotRow[] {
  return d1Query<LotRow>(`
    SELECT p.id, p.name, p.address
    FROM parking_lots p
    LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
    WHERE (s.ai_summary IS NULL OR s.ai_summary = '')
      AND EXISTS (
        SELECT 1 FROM web_sources w
        WHERE w.parking_lot_id = p.id
          AND w.ai_summary IS NOT NULL AND w.ai_summary != ''
      )
    ORDER BY COALESCE(s.final_score, 0) DESC
    LIMIT ${n}
  `);
}

function main() {
  const lots = isMixed ? pickMixed() : pickDefault(limit);
  if (lots.length === 0) {
    console.error("매칭된 주차장 없음");
    process.exit(1);
  }

  console.log(`lots ${lots.length}건 — bulk fetching web_summaries...`);
  // Chunk IN clause to avoid SQL length limits (D1: ~100 IDs per chunk safe)
  const CHUNK = 100;
  const webMap = new Map<string, string[]>();
  const revMap = new Map<string, string[]>();
  for (let i = 0; i < lots.length; i += CHUNK) {
    const ids = lots.slice(i, i + CHUNK).map((l) => l.id);
    const w = fetchAllWebSummaries(ids);
    const r = fetchAllReviews(ids);
    for (const [k, v] of w) webMap.set(k, v);
    for (const [k, v] of r) revMap.set(k, v);
    if ((i / CHUNK) % 5 === 0) {
      console.log(`  fetched ${Math.min(i + CHUNK, lots.length)}/${lots.length}`);
    }
  }

  const result: AgentInput[] = lots.map((lot) => ({
    id: lot.id,
    name: lot.name,
    address: lot.address,
    web_summaries: webMap.get(lot.id) ?? [],
    reviews: revMap.get(lot.id) ?? [],
  }));

  writeFileSync(output, JSON.stringify(result, null, 2), "utf-8");

  const withWeb = result.filter((r) => r.web_summaries.length > 0).length;
  const withRev = result.filter((r) => r.reviews.length > 0).length;
  console.log(`\n=== 추출 완료 ===`);
  console.log(`출력: ${output}`);
  console.log(`주차장 ${result.length}건 (web 보유 ${withWeb}, review 보유 ${withRev})`);
  if (isMixed) {
    for (const r of result) {
      console.log(`  - ${r.id} ${r.name}: web ${r.web_summaries.length}건, review ${r.reviews.length}건`);
    }
  }
}

main();
