/**
 * 헬 주차장 큐레이션 태깅 스크립트
 *
 * 1) 수동 큐레이션 리스트(hell-parking-list.json)의 주차장을 DB에서 매칭
 * 2) parking_lots.is_curated / curation_tag / curation_reason 업데이트
 * 3) crawled_reviews에서 부정 키워드 빈도 기반 추가 후보 제안
 *
 * 사용법: bun run scripts/curate-hell-parking.ts [--suggest]
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";

const TMP_SQL = resolve(import.meta.dir, "../.tmp-curate.sql");
const LIST_JSON = resolve(import.meta.dir, "hell-parking-list.json");

// ── 수동 큐레이션 리스트 타입 ──
interface CuratedEntry {
  id?: string; // DB id (있으면 직접 매칭)
  name: string; // 주차장명 (검색용)
  tag: "hell" | "easy";
  reason: string; // "골뱅이 나선형", "넓은 평면" 등
}

// ── DB 헬퍼 ──
function esc(s: string): string {
  return s.replace(/'/g, "''");
}

function queryDB(sql: string): any[] {
  const raw = execSync(
    `npx wrangler d1 execute parking-db --local --command "${sql.replace(/"/g, '\\"')}" --json`,
    { encoding: "utf-8", maxBuffer: 100 * 1024 * 1024 }
  );
  return JSON.parse(raw)[0]?.results ?? [];
}

function executeSQL(sql: string) {
  writeFileSync(TMP_SQL, sql);
  execSync(`npx wrangler d1 execute parking-db --local --file="${TMP_SQL}"`, {
    stdio: "pipe",
  });
}

// ── 이름으로 주차장 검색 ──
function findParkingByName(name: string): { id: string; name: string; address: string }[] {
  // LIKE 검색 — 핵심 키워드 추출
  const keywords = name
    .replace(/주차장|주차/g, "")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (keywords.length === 0) return [];

  const conditions = keywords.map((kw) => `name LIKE '%${esc(kw)}%'`).join(" AND ");
  return queryDB(`SELECT id, name, address FROM parking_lots WHERE ${conditions} LIMIT 10`);
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

    // id가 없으면 이름으로 검색
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
        // 첫 번째 결과 사용
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
    executeSQL(stmts.join("\n"));
    console.log(`\n✅ ${matched}개 태깅 완료, ${unmatched}개 매칭 실패`);
  } else {
    console.log("\n태깅할 항목이 없습니다.");
  }

  // 결과 확인
  const tagged = queryDB(
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
  console.log("\n🔍 crawled_reviews 부정 키워드 기반 헬 주차장 후보:\n");

  const candidates = queryDB(`
    SELECT p.id, p.name, p.address, COUNT(*) as neg
    FROM parking_lots p
    JOIN crawled_reviews cr ON cr.parking_lot_id = p.id
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

if (existsSync(TMP_SQL)) unlinkSync(TMP_SQL);
