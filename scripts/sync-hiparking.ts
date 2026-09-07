/**
 * 하이파킹(AJ파크) 정기권 지점 목록 → D1 신규 등록
 *
 * 사용법:
 *   bun run scripts/sync-hiparking.ts              # 로컬 D1
 *   bun run scripts/sync-hiparking.ts --remote     # 리모트 D1
 *   bun run scripts/sync-hiparking.ts --dry-run    # 변경사항만 출력, DB 미반영
 *
 * 소스: https://mobile.ajpark.co.kr/api/park/park_list_detail (인증 불필요, 공개 API)
 * 기존 KA-/NV-/공공데이터와 좌표 반경 dedup 후 겹치지 않는 건만 HP-{parkingLotId}로 신규 등록.
 * 대부분 건물/시설 부설 주차장(은행·병원·아파트·오피스·대학 등)이라 type='부설' 고정.
 */
import { resolve } from "path";
import { d1ExecFile, isRemote } from "./lib/d1";
import { sqlVal } from "./lib/sql-flush";
import { loadExistingLots, nearestLot } from "./lib/place-match";
import { writeFileSync, unlinkSync } from "fs";

const DRY_RUN = process.argv.includes("--dry-run");
const DEDUP_RADIUS_M = 60;

const API_URL = "https://mobile.ajpark.co.kr/api/park/park_list_detail";

interface ApiItem {
  parkingLotId: number;
  name: string;
  addr1: string;
  addr2: string;
  latitude: number;
  longitude: number;
  oneHourPrice: number | null;
  monthlyTicketAvailable: string;
  operationType: string;
}

interface DbRow {
  id: string;
  name: string;
  type: string;
  address: string;
  lat: number;
  lng: number;
  total_spaces: number;
  is_free: number;
  base_time: number | null;
  base_fee: number | null;
  phone: string | null;
  payment_methods: string | null;
  notes: string | null;
}

async function fetchAll(): Promise<ApiItem[]> {
  const res = await fetch(API_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const json = await res.json();
  return json.parkingLotList ?? [];
}

function toDbRow(item: ApiItem): DbRow | null {
  const lat = item.latitude;
  const lng = item.longitude;
  if (!lat || !lng || lat < 33 || lat > 39 || lng < 124 || lng > 132) return null;
  if (!item.parkingLotId || !item.name) return null;

  const isFree = item.oneHourPrice === 0;

  return {
    id: `HP-${item.parkingLotId}`,
    name: item.name.trim(),
    type: "부설",
    address: `${item.addr1 ?? ""} ${item.addr2 ?? ""}`.trim(),
    lat,
    lng,
    total_spaces: 0,
    is_free: isFree ? 1 : 0,
    base_time: !isFree && item.oneHourPrice != null ? 60 : null,
    base_fee: !isFree && item.oneHourPrice != null ? item.oneHourPrice : null,
    phone: null,
    payment_methods: null,
    notes: item.monthlyTicketAvailable === "y" ? "정기권 가능" : null,
  };
}

function buildUpsert(row: DbRow): string {
  const cols = [
    "id", "name", "type", "address", "lat", "lng", "total_spaces",
    "is_free", "base_time", "base_fee", "phone", "payment_methods", "notes",
  ];
  const vals = [
    sqlVal(row.id), sqlVal(row.name), sqlVal(row.type), sqlVal(row.address),
    row.lat, row.lng, row.total_spaces, row.is_free,
    sqlVal(row.base_time), sqlVal(row.base_fee),
    sqlVal(row.phone), sqlVal(row.payment_methods), sqlVal(row.notes),
  ];
  const updateSet = cols
    .filter((c) => c !== "id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  return `INSERT INTO parking_lots (${cols.join(", ")}) VALUES (${vals.join(", ")}) ON CONFLICT(id) DO UPDATE SET ${updateSet}, updated_at = datetime('now');`;
}

async function main() {
  console.log(`=== 하이파킹(AJ파크) 지점 동기화 ===`);
  console.log(`모드: ${DRY_RUN ? "DRY-RUN (DB 미반영)" : isRemote ? "REMOTE" : "LOCAL"}\n`);

  console.log("📡 API 데이터 수집 중...");
  const apiItems = await fetchAll();
  console.log(`API 총 ${apiItems.length}건\n`);

  const apiRows: DbRow[] = [];
  let skipped = 0;
  for (const item of apiItems) {
    const row = toDbRow(item);
    if (row) apiRows.push(row);
    else skipped++;
  }
  console.log(`파싱: ${apiRows.length}건 유효, ${skipped}건 스킵 (좌표 무효/필수값 없음)\n`);

  console.log("💾 기존 DB 주차장 로드 중 (좌표 dedup)...");
  const existingLots = loadExistingLots();
  const existingIds = new Set(existingLots.map((l) => l.id));
  console.log(`기존 ${existingLots.length.toLocaleString()}건 로드\n`);

  const newRows: DbRow[] = [];
  const updateRows: DbRow[] = [];
  const collisions: { hp: DbRow; existing: { id: string; name: string }; dist: number }[] = [];

  for (const row of apiRows) {
    if (existingIds.has(row.id)) {
      updateRows.push(row);
      continue;
    }
    const nearest = nearestLot(row.lat, row.lng, existingLots);
    if (nearest && nearest.dist <= DEDUP_RADIUS_M) {
      collisions.push({ hp: row, existing: { id: nearest.lot.id, name: nearest.lot.name }, dist: nearest.dist });
    } else {
      newRows.push(row);
    }
  }

  console.log("📊 비교 결과:");
  console.log(`  신규 추가: ${newRows.length}건`);
  console.log(`  기존 HP- 갱신: ${updateRows.length}건`);
  console.log(`  기존 lot과 ${DEDUP_RADIUS_M}m 이내 충돌(스킵): ${collisions.length}건\n`);

  if (collisions.length > 0) {
    const outPath = resolve(import.meta.dir, "../data/hiparking-dedup-collisions.json");
    writeFileSync(
      outPath,
      JSON.stringify(
        collisions.map((c) => ({
          hp_name: c.hp.name,
          hp_address: c.hp.address,
          existing_id: c.existing.id,
          existing_name: c.existing.name,
          dist_m: Math.round(c.dist),
        })),
        null,
        2,
      ),
    );
    console.log(`⚠️  충돌 목록 저장: ${outPath}\n`);
  }

  const upsertRows = [...newRows, ...updateRows];
  if (upsertRows.length === 0) {
    console.log("✅ 변경사항 없음. 종료.");
    return;
  }

  if (DRY_RUN) {
    console.log(`🔍 DRY-RUN: ${upsertRows.length}건 UPSERT 예정 (DB 미반영)`);
    return;
  }

  console.log(`⚡ ${upsertRows.length}건 UPSERT 실행 중...`);
  const BATCH = 100;
  const tmpSql = resolve(import.meta.dir, "../.tmp-hiparking.sql");

  for (let i = 0; i < upsertRows.length; i += BATCH) {
    const slice = upsertRows.slice(i, i + BATCH);
    const stmts = slice.map(buildUpsert).join("\n");
    writeFileSync(tmpSql, stmts);
    d1ExecFile(tmpSql);

    const done = Math.min(i + BATCH, upsertRows.length);
    process.stdout.write(`\r  ${done}/${upsertRows.length} (${Math.round((done / upsertRows.length) * 100)}%)`);
  }

  try { unlinkSync(tmpSql); } catch {}
  console.log(`\n\n✅ 완료! ${upsertRows.length}건 UPSERT (신규 ${newRows.length} + 갱신 ${updateRows.length})`);
}

main().catch((err) => {
  console.error("❌ 에러:", err.message ?? err);
  process.exit(1);
});
