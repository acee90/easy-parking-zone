/**
 * 모두의주차장(MODU) 소스 주차장 운영시간/면수 백필
 *
 * pins API(geohash 배치)에는 운영시간이 없어서, 지점 상세페이지(app.modu.kr/map?type=P&id=)를
 * 낱개로 fetch해서 서버렌더링된 HTML에서 "운영 시간"/"N면" 텍스트를 정규식으로 추출한다.
 *
 * 사용법:
 *   bun run scripts/backfill-modu-hours.ts              # 로컬 D1
 *   bun run scripts/backfill-modu-hours.ts --remote     # 리모트 D1
 *   bun run scripts/backfill-modu-hours.ts --dry-run    # 변경사항만 출력, DB 미반영
 *   bun run scripts/backfill-modu-hours.ts --limit=50   # 앞 N건만 (테스트용)
 */
import { resolve } from "path";
import { d1Query, d1ExecFile, isRemote } from "./lib/d1";
import { sqlVal } from "./lib/sql-flush";
import { writeFileSync, unlinkSync } from "fs";

const DRY_RUN = process.argv.includes("--dry-run");
const DELAY_MS = 150;

function getArg(name: string): number | null {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseInt(arg.split("=")[1]) : null;
}
const LIMIT = getArg("limit");

interface LotRow {
  id: string;
  total_spaces: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchDetail(parkinglotSeq: string): Promise<{ hours: string | null; spaces: number | null }> {
  const url = `https://app.modu.kr/map?type=P&id=${parkinglotSeq}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15" },
  });
  if (!res.ok) return { hours: null, spaces: null };
  const html = await res.text();

  const hoursMatch = html.match(/>운영 시간<\/span><span[^>]*>([^<]+)<\/span>/);
  const hours = hoursMatch ? hoursMatch[1].trim() : null;

  const spacesMatch = html.match(/>(\d{1,5})면<\/span>/);
  const spaces = spacesMatch ? parseInt(spacesMatch[1]) : null;

  return { hours, spaces };
}

function parseHours(raw: string): { start: string; end: string } | null {
  const m = raw.match(/(\d{2}:\d{2})\s*~\s*(\d{2}:\d{2})/);
  if (!m) return null;
  return { start: m[1], end: m[2] };
}

function buildUpdate(id: string, start: string, end: string, spaces: number | null, currentSpaces: number): string {
  const sets = [
    `weekday_start = ${sqlVal(start)}`,
    `weekday_end = ${sqlVal(end)}`,
    `saturday_start = ${sqlVal(start)}`,
    `saturday_end = ${sqlVal(end)}`,
    `holiday_start = ${sqlVal(start)}`,
    `holiday_end = ${sqlVal(end)}`,
    `updated_at = datetime('now')`,
  ];
  if (spaces != null && spaces > 0 && currentSpaces === 0) {
    sets.push(`total_spaces = ${spaces}`);
  }
  return `UPDATE parking_lots SET ${sets.join(", ")} WHERE id = ${sqlVal(id)};`;
}

async function main() {
  console.log(`=== MODU 운영시간/면수 백필 ===`);
  console.log(`모드: ${DRY_RUN ? "DRY-RUN (DB 미반영)" : isRemote ? "REMOTE" : "LOCAL"}\n`);

  let lots = d1Query<LotRow>(
    `SELECT id, total_spaces FROM parking_lots WHERE id LIKE 'MODU-%' AND (weekday_start IS NULL OR weekday_start = '') ORDER BY id`,
  );
  if (LIMIT) lots = lots.slice(0, LIMIT);
  console.log(`대상: ${lots.length}건\n`);

  const updates: string[] = [];
  let parsed = 0;
  let noHours = 0;
  let unparsable = 0;
  const unparsableSamples: string[] = [];

  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i];
    const seq = lot.id.replace("MODU-", "");
    try {
      const { hours, spaces } = await fetchDetail(seq);
      if (!hours) {
        noHours++;
      } else {
        const parsedHours = parseHours(hours);
        if (!parsedHours) {
          unparsable++;
          if (unparsableSamples.length < 10) unparsableSamples.push(`${lot.id}: "${hours}"`);
        } else {
          parsed++;
          updates.push(buildUpdate(lot.id, parsedHours.start, parsedHours.end, spaces, lot.total_spaces));
        }
      }
    } catch (err) {
      noHours++;
    }
    process.stdout.write(`\r  ${i + 1}/${lots.length} (파싱 ${parsed}, 운영시간없음 ${noHours}, 형식불일치 ${unparsable})`);
    await sleep(DELAY_MS);
  }
  console.log("\n");

  if (unparsableSamples.length > 0) {
    console.log("⚠️  형식 불일치 샘플:");
    for (const s of unparsableSamples) console.log(`  - ${s}`);
    console.log();
  }

  console.log(`📊 결과: 파싱 성공 ${parsed}건 / 운영시간 텍스트 없음 ${noHours}건 / 형식 불일치 ${unparsable}건\n`);

  if (updates.length === 0) {
    console.log("✅ 반영할 변경사항 없음. 종료.");
    return;
  }

  if (DRY_RUN) {
    console.log(`🔍 DRY-RUN: ${updates.length}건 UPDATE 예정 (DB 미반영)`);
    return;
  }

  console.log(`⚡ ${updates.length}건 UPDATE 실행 중...`);
  const BATCH = 100;
  const tmpSql = resolve(import.meta.dir, "../.tmp-modu-hours.sql");

  for (let i = 0; i < updates.length; i += BATCH) {
    const slice = updates.slice(i, i + BATCH);
    writeFileSync(tmpSql, slice.join("\n"));
    d1ExecFile(tmpSql);
    const done = Math.min(i + BATCH, updates.length);
    process.stdout.write(`\r  ${done}/${updates.length}`);
  }
  try { unlinkSync(tmpSql); } catch {}
  console.log(`\n\n✅ 완료! ${updates.length}건 운영시간 반영`);
}

main().catch((err) => {
  console.error("❌ 에러:", err.message ?? err);
  process.exit(1);
});
