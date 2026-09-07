/**
 * 하이파킹(AJ파크) 소스 주차장 상세정보(운영시간/면수/전화/일일요금) 백필
 *
 * park_list_detail(목록)엔 이름/주소/좌표/1시간요금뿐이라, 지점별 상세 API를 따로 호출한다.
 *
 * 사용법:
 *   bun run scripts/backfill-hiparking-detail.ts              # 로컬 D1
 *   bun run scripts/backfill-hiparking-detail.ts --remote     # 리모트 D1
 *   bun run scripts/backfill-hiparking-detail.ts --dry-run    # 변경사항만 출력, DB 미반영
 *   bun run scripts/backfill-hiparking-detail.ts --limit=20   # 앞 N건만 (테스트용)
 */
import { resolve } from "path";
import { d1Query, d1ExecFile, isRemote } from "./lib/d1";
import { sqlVal } from "./lib/sql-flush";
import { writeFileSync, unlinkSync } from "fs";

const DRY_RUN = process.argv.includes("--dry-run");
const DELAY_MS = 150;
const API_URL = "https://mobile.ajpark.co.kr/api/park/park_detail";

function getArg(name: string): number | null {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseInt(arg.split("=")[1]) : null;
}
const LIMIT = getArg("limit");

interface LotRow {
  id: string;
  total_spaces: number;
  phone: string | null;
  base_fee: number | null;
}

interface ParkDetail {
  tel: string | null;
  spaceNum: number | null;
  dailyOpenTime: string | null;
  satOpenTime: string | null;
  holOpenTime: string | null;
  oneHourPrice: number | null;
  dailyPrice: number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchDetail(parkingLotId: string): Promise<ParkDetail | null> {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `park=${parkingLotId}`,
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  return json.parkInfo ?? null;
}

function parseTimeRange(raw: string | null): { start: string; end: string } | null {
  if (!raw) return null;
  const m = raw.match(/(\d{2}:\d{2})\s*~\s*(\d{2}:\d{2})/);
  if (!m) return null;
  // 소스가 24시간 운영을 "00:00~00:00"으로 표기하는 관행 — 00:00~24:00으로 통일
  const end = m[1] === m[2] ? "24:00" : m[2];
  return { start: m[1], end };
}

function formatPhone(tel: string | null): string | null {
  if (!tel) return null;
  const d = tel.replace(/\D/g, "");
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4)}`;
  if (d.startsWith("02")) {
    if (d.length === 9) return `02-${d.slice(2, 5)}-${d.slice(5)}`;
    if (d.length === 10) return `02-${d.slice(2, 6)}-${d.slice(6)}`;
  }
  if (d.length === 10) return `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11) return `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7)}`;
  return d || null;
}

function buildUpdate(lot: LotRow, detail: ParkDetail): string | null {
  const weekday = parseTimeRange(detail.dailyOpenTime);
  const sat = parseTimeRange(detail.satOpenTime) ?? weekday;
  const hol = parseTimeRange(detail.holOpenTime) ?? weekday;
  const phone = formatPhone(detail.tel);

  const sets: string[] = [`updated_at = datetime('now')`];
  let changed = false;

  if (weekday) {
    sets.push(`weekday_start = ${sqlVal(weekday.start)}`, `weekday_end = ${sqlVal(weekday.end)}`);
    changed = true;
  }
  if (sat) {
    sets.push(`saturday_start = ${sqlVal(sat.start)}`, `saturday_end = ${sqlVal(sat.end)}`);
    changed = true;
  }
  if (hol) {
    sets.push(`holiday_start = ${sqlVal(hol.start)}`, `holiday_end = ${sqlVal(hol.end)}`);
    changed = true;
  }
  if (phone && !lot.phone) {
    sets.push(`phone = ${sqlVal(phone)}`);
    changed = true;
  }
  if (detail.spaceNum != null && detail.spaceNum > 0 && lot.total_spaces === 0) {
    sets.push(`total_spaces = ${detail.spaceNum}`);
    changed = true;
  }
  if (detail.dailyPrice != null && detail.dailyPrice > 0) {
    sets.push(`daily_max = ${detail.dailyPrice}`);
    changed = true;
  }
  if (detail.oneHourPrice != null && detail.oneHourPrice > 0 && lot.base_fee == null) {
    sets.push(`base_time = 60`, `base_fee = ${detail.oneHourPrice}`);
    changed = true;
  }

  if (!changed) return null;
  return `UPDATE parking_lots SET ${sets.join(", ")} WHERE id = ${sqlVal(lot.id)};`;
}

async function main() {
  console.log(`=== 하이파킹 상세정보 백필 ===`);
  console.log(`모드: ${DRY_RUN ? "DRY-RUN (DB 미반영)" : isRemote ? "REMOTE" : "LOCAL"}\n`);

  let lots = d1Query<LotRow>(
    `SELECT id, total_spaces, phone, base_fee FROM parking_lots WHERE id LIKE 'HP-%' ORDER BY id`,
  );
  if (LIMIT) lots = lots.slice(0, LIMIT);
  console.log(`대상: ${lots.length}건\n`);

  const updates: string[] = [];
  let ok = 0;
  let failed = 0;

  for (let i = 0; i < lots.length; i++) {
    const lot = lots[i];
    const parkingLotId = lot.id.replace("HP-", "");
    try {
      const detail = await fetchDetail(parkingLotId);
      if (!detail) {
        failed++;
      } else {
        const stmt = buildUpdate(lot, detail);
        if (stmt) {
          updates.push(stmt);
          ok++;
        } else {
          failed++;
        }
      }
    } catch {
      failed++;
    }
    process.stdout.write(`\r  ${i + 1}/${lots.length} (반영예정 ${ok}, 실패/변경없음 ${failed})`);
    await sleep(DELAY_MS);
  }
  console.log("\n");

  console.log(`📊 결과: 반영 대상 ${ok}건 / 실패·변경없음 ${failed}건\n`);

  if (updates.length === 0) {
    console.log("✅ 반영할 변경사항 없음. 종료.");
    return;
  }

  if (DRY_RUN) {
    console.log(`🔍 DRY-RUN: ${updates.length}건 UPDATE 예정 (DB 미반영)`);
    console.log(updates.slice(0, 3).join("\n"));
    return;
  }

  console.log(`⚡ ${updates.length}건 UPDATE 실행 중...`);
  const BATCH = 100;
  const tmpSql = resolve(import.meta.dir, "../.tmp-hiparking-detail.sql");

  for (let i = 0; i < updates.length; i += BATCH) {
    const slice = updates.slice(i, i + BATCH);
    writeFileSync(tmpSql, slice.join("\n"));
    d1ExecFile(tmpSql);
    const done = Math.min(i + BATCH, updates.length);
    process.stdout.write(`\r  ${done}/${updates.length}`);
  }
  try { unlinkSync(tmpSql); } catch {}
  console.log(`\n\n✅ 완료! ${updates.length}건 상세정보 반영`);
}

main().catch((err) => {
  console.error("❌ 에러:", err.message ?? err);
  process.exit(1);
});
