/**
 * 클리앙 댓글 → 리뷰 데이터 생성 (AI 매칭 기반)
 *
 * AI가 257개 댓글 스레드를 분석하여 47개 등록 주차장에 매칭한 결과를
 * reviews 테이블에 INSERT (source_type='clien', 모든 점수=1 극악)
 *
 * 사용법: bun run scripts/import-clien-comments.ts [--dry-run] [--remote]
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { esc, flushStatements } from "./lib/sql-flush";

const COMMENTS_JSON = resolve(import.meta.dir, "clien-comments-raw.json");
const MATCHED_JSON = resolve(import.meta.dir, "clien-comments-ai-matched.json");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-clien-comments.sql");
const SOURCE_URL = "https://www.clien.net/service/board/cm_car/14055871";
const DRY_RUN = process.argv.includes("--dry-run");

interface RawComment {
  id: string;
  authorId: string;
  nickname: string;
  content: string;
  date: string;
  likes: number;
  isReply: boolean;
  isByAuthor: boolean;
}

interface AiMatch {
  commentId: string;
  lotId: string;
  via: "direct" | "parent";
  note: string;
}

// ── 데이터 로드 ──

const comments: RawComment[] = JSON.parse(
  readFileSync(COMMENTS_JSON, "utf-8")
);
const commentById = new Map(comments.map((c) => [c.id, c]));

const aiMatches: AiMatch[] = JSON.parse(
  readFileSync(MATCHED_JSON, "utf-8")
);

console.log(`📋 댓글 ${comments.length}개 로드`);
console.log(`🤖 AI 매칭 ${aiMatches.length}건 로드\n`);

// ── 매칭별 리뷰 생성 ──

interface ReviewEntry {
  lotId: string;
  nickname: string;
  comment: string;
  via: string;
}

const reviews: ReviewEntry[] = [];
const seenKeys = new Set<string>();
let skippedNoComment = 0;
let skippedDuplicate = 0;
let skippedNotFound = 0;

for (const match of aiMatches) {
  const c = commentById.get(match.commentId);
  if (!c) {
    skippedNotFound++;
    continue;
  }

  // 댓글 내용 정리 (@ 멘션 제거)
  let content = c.content.replace(/｢@[^｣]*님｣\s*/g, "").trim();
  if (content.length < 5) {
    skippedNoComment++;
    continue;
  }

  // 중복 방지: 같은 주차장+같은 댓글 내용 앞 50자
  const key = `${match.lotId}:${content.slice(0, 50)}`;
  if (seenKeys.has(key)) {
    skippedDuplicate++;
    continue;
  }
  seenKeys.add(key);

  reviews.push({
    lotId: match.lotId,
    nickname: c.nickname,
    comment: content.length > 200 ? content.slice(0, 197) + "..." : content,
    via: match.via,
  });
}

// ── 결과 출력 ──

console.log(`=== 리뷰 생성 결과 ===`);
console.log(`✅ 리뷰: ${reviews.length}건`);
console.log(`  - 직접 매칭: ${reviews.filter((r) => r.via === "direct").length}건`);
console.log(`  - parent 상속: ${reviews.filter((r) => r.via === "parent").length}건`);
console.log(`⏭️ 스킵: 댓글없음=${skippedNoComment}, 중복=${skippedDuplicate}, 미발견=${skippedNotFound}\n`);

// 주차장별 그룹핑
const byLot = new Map<string, ReviewEntry[]>();
for (const r of reviews) {
  const arr = byLot.get(r.lotId) || [];
  arr.push(r);
  byLot.set(r.lotId, arr);
}

console.log(`📊 ${byLot.size}개 주차장에 리뷰 분배:\n`);
for (const [lotId, items] of byLot) {
  const direct = items.filter((i) => i.via === "direct").length;
  const parent = items.filter((i) => i.via === "parent").length;
  console.log(`  ${lotId}: ${items.length}건 [직접 ${direct}, 상속 ${parent}]`);
  for (const item of items.slice(0, 2)) {
    console.log(`    "${item.comment.slice(0, 60)}..." [${item.via}]`);
  }
  if (items.length > 2) console.log(`    ... +${items.length - 2}건`);
}

if (DRY_RUN) {
  console.log("\n🔍 [DRY RUN] SQL 미실행");
  process.exit(0);
}

if (reviews.length === 0) {
  console.log("\n⚠️ 리뷰가 없습니다");
  process.exit(0);
}

// ── SQL INSERT ──

const stmts: string[] = [];
for (const r of reviews) {
  stmts.push(
    `INSERT INTO reviews (parking_lot_id, guest_nickname, entry_score, space_score, passage_score, exit_score, overall_score, comment, is_seed, source_type, source_url) VALUES ('${esc(r.lotId)}', '${esc(r.nickname)}', 1, 1, 1, 1, 1, '${esc(r.comment)}', 1, 'clien', '${esc(SOURCE_URL)}');`
  );
}

flushStatements(TMP_SQL, stmts);
console.log(`\n✅ ${stmts.length}건 리뷰 INSERT 완료`);
