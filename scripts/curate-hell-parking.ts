/**
 * 헬 주차장 큐레이션 태깅 스크립트
 *
 * 1) 수동 큐레이션 리스트(hell-parking-list.json)의 주차장을 DB에서 매칭
 * 2) parking_lots.is_curated / curation_tag / curation_reason 업데이트
 * 3) web_sources에서 부정 키워드 빈도 기반 추가 후보 제안
 *
 * 사용법: bun run scripts/curate-hell-parking.ts [--suggest]
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { d1Query, isRemote } from "./lib/d1";
import { esc, flushStatements } from "./lib/sql-flush";

const TMP_SQL = resolve(import.meta.dir, "../.tmp-curate.sql");
const LIST_JSON = resolve(import.meta.dir, "hell-parking-list.json");

if (isRemote) console.log("🌐 리모트 D1 모드\n");

// ── 수동 큐레이션 리스트 타입 ──
interface CuratedEntry {
  id?: string;
  name: string;
  tag: "hell" | "easy";
  reason: string;
}

// ── 이름으로 주차장 검색 ──
function findParkingByName(name: string): { id: string; name: string; address: string }[] {
  const keywords = name
    .replace(/주차장|주차/g, "")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (keywords.length === 0) return [];

  const conditions = keywords.map((kw) => `name LIKE '%${esc(kw)}%'`).join(" AND ");
  return d1Query(`SELECT id, name, address FROM parking_lots WHERE ${conditions} LIMIT 10`);
}

// ── 메인: 태깅 ──
function applyTags() {
  if (!existsSync(LIST_JSON)) {
    console.error(`❌ ${LIST_JSON} 파일이 없습니다. 먼저 리스트를 작성하세요.`);
    console.log("\n예시 형식:");
    console.log(
      JSON.stringify(
        [
          { id: "KA-27508271", name: "타임스퀘어 주차장", tag: "hell", reason: "좁은 골뱅이 나선형 진입로" },
          { name: "넓은평면 주차장", tag: "easy", reason: "넓은 평면, 기둥 간격 여유" },
        ],
        null,
        2
      )
    );
    process.exit(1);
  }

  const entries: CuratedEntry[] = JSON.parse(readFileSync(LIST_JSON, "utf-8"));
  console.log(`📋 큐레이션 리스트: ${entries.length}개`);

  const stmts: string[] = [];
  let matched = 0;
  let unmatched = 0;

  for (const entry of entries) {
    let targetId = entry.id;

    if (!targetId) {
      const candidates = findParkingByName(entry.name);
      if (candidates.length === 0) {
        console.warn(`  ⚠️ 매칭 실패: "${entry.name}" — DB에서 찾을 수 없음`);
        unmatched++;
        continue;
      }
      if (candidates.length > 1) {
        console.warn(`  ⚠️ 다중 매칭: "${entry.name}" → ${candidates.length}건`);
        for (const c of candidates) {
          console.warn(`     - ${c.id} | ${c.name} | ${c.address}`);
        }
      }
      targetId = candidates[0].id;
      console.log(`  ✅ "${entry.name}" → ${targetId} (${candidates[0].name})`);
    }

    stmts.push(
      `UPDATE parking_lots SET is_curated = 1, curation_tag = '${entry.tag}', curation_reason = '${esc(entry.reason)}' WHERE id = '${esc(targetId)}';`
    );
    matched++;
  }

  if (stmts.length > 0) {
    flushStatements(TMP_SQL, stmts);
    console.log(`\n✅ ${matched}개 태깅 완료, ${unmatched}개 매칭 실패`);
  } else {
    console.log("\n태깅할 항목이 없습니다.");
  }

  const tagged = d1Query(
    "SELECT id, name, curation_tag, curation_reason FROM parking_lots WHERE is_curated = 1 ORDER BY curation_tag, name"
  );
  console.log(`\n📊 현재 큐레이션 현황:`);
  const hellCount = tagged.filter((r: any) => r.curation_tag === "hell").length;
  const easyCount = tagged.filter((r: any) => r.curation_tag === "easy").length;
  console.log(`  🔥 헬 주차장: ${hellCount}개`);
  console.log(`  😊 초보 추천: ${easyCount}개`);
}

// ── 서브: 자동 후보 제안 ──
function suggestCandidates() {
  console.log("\n🔍 web_sources 부정 키워드 기반 헬 주차장 후보:\n");

  const candidates = d1Query(`
    SELECT p.id, p.name, p.address, COUNT(*) as neg
    FROM parking_lots p
    JOIN web_sources cr ON cr.parking_lot_id = p.id
    WHERE (cr.content LIKE '%좁%' OR cr.content LIKE '%무서%'
       OR cr.content LIKE '%힘들%' OR cr.content LIKE '%골뱅이%'
       OR cr.content LIKE '%긁%' OR cr.content LIKE '%기계식%'
       OR cr.content LIKE '%나선%' OR cr.content LIKE '%경사%')
      AND p.is_curated = 0
    GROUP BY p.id
    HAVING neg >= 2
    ORDER BY neg DESC
    LIMIT 50
  `);

  for (const c of candidates) {
    console.log(`  [${c.neg}] ${c.name} | ${c.address} | ${c.id}`);
  }
  console.log(`\n총 ${candidates.length}개 후보`);
}

// ── 실행 ──
const args = process.argv.slice(2);
if (args.includes("--suggest")) {
  suggestCandidates();
} else {
  applyTags();
}
