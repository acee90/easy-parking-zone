/**
 * 클리앙 극악 주차장 데이터 → DB 임포트
 *
 * - 본문(body) → crawled_reviews (source='clien') → 블로그 탭
 * - 댓글(comment) → reviews (source_type='clien') → 리뷰 탭
 *
 * 사용법: bun run scripts/import-clien-hell.ts [--remote] [--dry-run]
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { d1Query } from "./lib/d1";
import { esc, flushStatements } from "./lib/sql-flush";
import { createHash } from "crypto";

const TMP_SQL = resolve(import.meta.dir, "../.tmp-clien.sql");
const DATA_JSON = resolve(import.meta.dir, "clien-hell-parking.json");
const DRY_RUN = process.argv.includes("--dry-run");

interface ClienEntry {
  name: string;
  address: string;
  reason: string;
  from: "body" | "comment";
}

interface ClienData {
  sourceUrl: string;
  title: string;
  entries: ClienEntry[];
}

// ── 주소에서 지역 키워드 추출 (시/구/동) ──
function extractRegion(address: string): string[] {
  const parts = address.split(/\s+/);
  // "서울 종로구" → ["서울", "종로"] / "경기 고양시 덕양구" → ["고양", "덕양"]
  return parts
    .slice(0, 3)
    .map((p) => p.replace(/특별시|광역시|시|도|구|군|동$/g, ""))
    .filter((w) => w.length >= 2);
}

// ── 지역 일치 검증 ──
function matchesRegion(dbAddress: string, regionKeys: string[]): boolean {
  if (regionKeys.length === 0) return true;
  // 최소 1개 지역 키워드가 DB 주소에 포함
  return regionKeys.some((r) => dbAddress.includes(r));
}

// ── 이름에서 검색 키워드 추출 ──
function nameKeywords(name: string): string[] {
  return name
    .replace(/주차장|주차|지하|지상|건물|빌딩|점$|호텔|병원/g, "")
    .replace(/[()（）\-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

// ── 이름으로 주차장 검색 (지역 필터 포함) ──
function findByName(name: string, regionKeys: string[]): { id: string; name: string; address: string }[] {
  const keywords = nameKeywords(name);
  if (keywords.length === 0) return [];

  const conditions = keywords.map((kw) => `name LIKE '%${esc(kw)}%'`).join(" AND ");
  const candidates: { id: string; name: string; address: string }[] =
    d1Query(`SELECT id, name, address FROM parking_lots WHERE ${conditions} LIMIT 20`);

  // 지역 필터 적용
  if (regionKeys.length > 0) {
    const filtered = candidates.filter((c) => matchesRegion(c.address, regionKeys));
    return filtered;
  }
  return candidates;
}

// ── 주소 도로명으로 검색 (지역 필터 포함) ──
function findByAddress(address: string, regionKeys: string[]): { id: string; name: string; address: string }[] {
  const parts = address.split(/\s+/).filter((w) => w.length >= 2);
  // 도로명 + 번호 부분 (뒤에서 2개)
  const roadParts = parts.filter((p) => !p.match(/^(서울|경기|부산|대구|인천|대전|울산|광주|세종|충청|전라|경상|강원|제주)/));
  if (roadParts.length < 1) return [];

  const conditions = roadParts
    .slice(-2)
    .map((kw) => `address LIKE '%${esc(kw)}%'`)
    .join(" AND ");

  const candidates: { id: string; name: string; address: string }[] =
    d1Query(`SELECT id, name, address FROM parking_lots WHERE ${conditions} LIMIT 20`);

  // 지역 필터
  if (regionKeys.length > 0) {
    return candidates.filter((c) => matchesRegion(c.address, regionKeys));
  }
  return candidates;
}

// ── 매칭 시도: 이름 우선 → 주소 보조, 지역 검증 필수 ──
function matchParking(entry: ClienEntry): { id: string; name: string; address: string } | null {
  const regionKeys = extractRegion(entry.address);

  // 1차: 이름으로 매칭 (지역 필터 적용)
  let candidates = findByName(entry.name, regionKeys);
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    // 이름이 가장 유사한 것 선택 (키워드 매칭 수 기준)
    const kw = nameKeywords(entry.name);
    const scored = candidates.map((c) => ({
      ...c,
      score: kw.filter((k) => c.name.includes(k)).length,
    }));
    scored.sort((a, b) => b.score - a.score);
    if (scored[0].score >= 1) return scored[0];
  }

  // 2차: 주소로 매칭 (지역 필터 적용) + 이름 교차검증
  candidates = findByAddress(entry.address, regionKeys);
  if (candidates.length === 0) return null;

  // 이름 키워드와 교차검증
  const kw = nameKeywords(entry.name);
  if (kw.length > 0) {
    const nameMatched = candidates.filter((c) =>
      kw.some((k) => c.name.includes(k))
    );
    if (nameMatched.length >= 1) return nameMatched[0];
  }

  // 주소 매칭만으로는 신뢰도 낮음 → 매칭 안 함
  return null;
}

function sourceId(url: string, name: string): string {
  return createHash("md5").update(`${url}:${name}`).digest("hex").slice(0, 16);
}

// ── 메인 ──
function main() {
  const data: ClienData = JSON.parse(readFileSync(DATA_JSON, "utf-8"));
  console.log(`📋 클리앙 데이터: ${data.entries.length}개 항목`);
  console.log(`🔗 원본: ${data.sourceUrl}\n`);

  const bodyEntries = data.entries.filter((e) => e.from === "body");
  const commentEntries = data.entries.filter((e) => e.from === "comment");

  console.log(`  본문 항목: ${bodyEntries.length}개 → 블로그 탭`);
  console.log(`  댓글 항목: ${commentEntries.length}개 → 리뷰 탭\n`);

  const blogStmts: string[] = [];
  const reviewStmts: string[] = [];
  let matched = 0;
  let unmatched = 0;
  const unmatchedList: ClienEntry[] = [];

  // 본문 → crawled_reviews (블로그 탭)
  console.log("── 본문 → 블로그 탭 매칭 ──\n");
  for (const entry of bodyEntries) {
    const lot = matchParking(entry);
    if (!lot) {
      console.warn(`  ⚠️ 매칭 실패: "${entry.name}" (${entry.address})`);
      unmatched++;
      unmatchedList.push(entry);
      continue;
    }

    console.log(`  ✅ "${entry.name}" → ${lot.id} (${lot.name})`);
    matched++;

    const sid = sourceId(data.sourceUrl, entry.name);
    blogStmts.push(
      `INSERT OR IGNORE INTO crawled_reviews (parking_lot_id, source, source_id, title, content, source_url, author, relevance_score)` +
      ` VALUES ('${esc(lot.id)}', 'clien', '${sid}', '${esc(data.title)}', '${esc(entry.reason)}', '${esc(data.sourceUrl)}', '클리앙', 80);`
    );
  }

  // 댓글 → reviews (리뷰 탭)
  console.log("\n── 댓글 → 리뷰 탭 매칭 ──\n");
  for (const entry of commentEntries) {
    const lot = matchParking(entry);
    if (!lot) {
      console.warn(`  ⚠️ 매칭 실패: "${entry.name}" (${entry.address})`);
      unmatched++;
      unmatchedList.push(entry);
      continue;
    }

    console.log(`  ✅ "${entry.name}" → ${lot.id} (${lot.name})`);
    matched++;

    // 클리앙 댓글은 점수 정보가 없으므로 난이도 1(극악) 기본값
    reviewStmts.push(
      `INSERT INTO reviews (parking_lot_id, guest_nickname, entry_score, space_score, passage_score, exit_score, overall_score, comment, is_seed, source_type, source_url)` +
      ` VALUES ('${esc(lot.id)}', '클리앙 사용자', 1, 1, 1, 1, 1, '${esc(entry.reason)}', 1, 'clien', '${esc(data.sourceUrl)}');`
    );
  }

  console.log(`\n📊 결과: ${matched}개 매칭, ${unmatched}개 실패`);

  if (unmatchedList.length > 0) {
    console.log(`\n── 미매칭 항목 ──`);
    for (const e of unmatchedList) {
      console.log(`  [${e.from}] ${e.name} | ${e.address}`);
    }
  }

  if (DRY_RUN) {
    console.log("\n🔍 [DRY RUN] SQL 미실행");
    if (blogStmts.length > 0) {
      console.log(`\n블로그 SQL (${blogStmts.length}건):`);
      blogStmts.forEach((s) => console.log(`  ${s}`));
    }
    if (reviewStmts.length > 0) {
      console.log(`\n리뷰 SQL (${reviewStmts.length}건):`);
      reviewStmts.forEach((s) => console.log(`  ${s}`));
    }
    return;
  }

  const allStmts = [...blogStmts, ...reviewStmts];
  if (allStmts.length > 0) {
    flushStatements(TMP_SQL, allStmts);
    console.log(`\n✅ ${blogStmts.length}건 블로그 + ${reviewStmts.length}건 리뷰 INSERT 완료`);
  } else {
    console.log("\nINSERT할 항목이 없습니다.");
  }
}

main();
