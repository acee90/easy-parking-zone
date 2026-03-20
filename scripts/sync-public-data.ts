/**
 * 공공데이터포털 전국주차장정보표준데이터 API → D1 동기화
 *
 * 사용법:
 *   bun run sync-public-data              # 로컬 D1
 *   bun run sync-public-data --remote     # 리모트 D1
 *   bun run sync-public-data --dry-run    # 변경사항만 출력, DB 미반영
 *
 * 환경변수: DATA_GO_KR_SERVICE_KEY (공공데이터포털 인증키)
 */
import { resolve } from "path";
import { d1Query, d1ExecFile, isRemote } from "./lib/d1";
import { esc } from "./lib/sql-flush";
import { writeFileSync, unlinkSync } from "fs";

const DRY_RUN = process.argv.includes("--dry-run");
const SERVICE_KEY = process.env.DATA_GO_KR_SERVICE_KEY;
if (!SERVICE_KEY) {
  console.error("❌ DATA_GO_KR_SERVICE_KEY 환경변수가 필요합니다.");
  process.exit(1);
}

const API_URL = "http://api.data.go.kr/openapi/tn_pubr_prkplce_info_api";
const NUM_OF_ROWS = 500;
const DELAY_MS = 300;
const MAX_RETRIES = 3;

// ── API 타입 ──

interface ApiItem {
  prkplceNo: string;
  prkplceNm: string;
  prkplceSe: string;
  prkplceType: string;
  rdnmadr: string;
  lnmadr: string;
  prkcmprt: string;
  weekdayOperOpenHhmm: string;
  weekdayOperColseHhmm: string;
  satOperOperOpenHhmm: string;
  satOperCloseHhmm: string;
  holidayOperOpenHhmm: string;
  holidayCloseOpenHhmm: string;
  parkingchrgeInfo: string;
  basicTime: string;
  basicCharge: string;
  addUnitTime: string;
  addUnitCharge: string;
  dayCmmtkt: string;
  monthCmmtkt: string;
  metpay: string;
  spcmnt: string;
  phoneNumber: string;
  latitude: string;
  longitude: string;
  referenceDate: string;
}

interface DbRow {
  id: string;
  name: string;
  type: string;
  address: string;
  lat: number;
  lng: number;
  total_spaces: number;
  weekday_start: string;
  weekday_end: string;
  saturday_start: string;
  saturday_end: string;
  holiday_start: string;
  holiday_end: string;
  is_free: number;
  base_time: number;
  base_fee: number;
  extra_time: number;
  extra_fee: number;
  daily_max: number | null;
  monthly_pass: number | null;
  phone: string;
  payment_methods: string;
  notes: string;
}

// ── API 호출 ──

async function fetchPage(pageNo: number): Promise<{ items: ApiItem[]; totalCount: number }> {
  const params = new URLSearchParams({
    serviceKey: SERVICE_KEY!,
    pageNo: String(pageNo),
    numOfRows: String(NUM_OF_ROWS),
    type: "json",
  });

  const url = `${API_URL}?${params}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

      const rawText = await res.text();
      // 공공데이터 API 응답에 이스케이프 안 된 제어 문자(탭 등)가 포함되어 있음
      const text = rawText.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
                          .replace(/\t/g, " ");
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`JSON 파싱 실패 (${text.length}자, 시작: ${text.slice(0, 100)}...)`);
      }
      const header = json.response?.header;
      const body = json.response?.body;

      if (!header || header.resultCode !== "00") {
        const code = header?.resultCode ?? "??";
        const msg = header?.resultMsg ?? "Unknown";
        if (code === "22") {
          console.warn(`\n⚠️  쿼터 초과 (page ${pageNo}). 수집된 데이터까지만 처리합니다.`);
          return { items: [], totalCount: 0 };
        }
        throw new Error(`API 에러 [${code}]: ${msg}`);
      }

      return {
        items: body.items ?? [],
        totalCount: parseInt(body.totalCount) || 0,
      };
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      const delay = DELAY_MS * Math.pow(2, attempt);
      console.warn(`\n  재시도 ${attempt}/${MAX_RETRIES} (${delay}ms 대기)...`);
      await sleep(delay);
    }
  }

  throw new Error("unreachable");
}

async function fetchAll(): Promise<ApiItem[]> {
  const first = await fetchPage(1);
  const totalCount = first.totalCount;
  const totalPages = Math.ceil(totalCount / NUM_OF_ROWS);
  console.log(`API 총 ${totalCount}건, ${totalPages}페이지`);

  const items = [...first.items];
  process.stdout.write(`  1/${totalPages} (${items.length}건)`);

  for (let page = 2; page <= totalPages; page++) {
    await sleep(DELAY_MS);
    const result = await fetchPage(page);
    if (result.items.length === 0 && result.totalCount === 0) break; // 쿼터 초과
    items.push(...result.items);
    process.stdout.write(`\r  ${page}/${totalPages} (${items.length}건)`);
  }
  console.log();

  return items;
}

// ── 매핑 ──

function mapType(apiType: string): string {
  if (apiType.includes("노상")) return "노상";
  if (apiType.includes("노외")) return "노외";
  if (apiType.includes("부설")) return "부설";
  return apiType || "노외";
}

function toDbRow(item: ApiItem): DbRow | null {
  const lat = parseFloat(item.latitude);
  const lng = parseFloat(item.longitude);
  if (!lat || !lng || lat < 33 || lat > 39 || lng < 124 || lng > 132) return null;

  const id = item.prkplceNo;
  if (!id) return null;

  return {
    id,
    name: item.prkplceNm || "이름없음",
    type: mapType(item.prkplceType),
    address: item.rdnmadr || item.lnmadr || "",
    lat,
    lng,
    total_spaces: parseInt(item.prkcmprt) || 0,
    weekday_start: item.weekdayOperOpenHhmm || "00:00",
    weekday_end: item.weekdayOperColseHhmm || "00:00",
    saturday_start: item.satOperOperOpenHhmm || "00:00",
    saturday_end: item.satOperCloseHhmm || "00:00",
    holiday_start: item.holidayOperOpenHhmm || "00:00",
    holiday_end: item.holidayCloseOpenHhmm || "00:00",
    is_free: item.parkingchrgeInfo === "무료" ? 1 : 0,
    base_time: parseInt(item.basicTime) || 0,
    base_fee: parseInt(item.basicCharge) || 0,
    extra_time: parseInt(item.addUnitTime) || 0,
    extra_fee: parseInt(item.addUnitCharge) || 0,
    daily_max: parseInt(item.dayCmmtkt) || null,
    monthly_pass: parseInt(item.monthCmmtkt) || null,
    phone: item.phoneNumber || "",
    payment_methods: item.metpay || "",
    notes: item.spcmnt || "",
  };
}

// ── 비교 ──

const COMPARE_FIELDS: (keyof DbRow)[] = [
  "name", "type", "address", "lat", "lng", "total_spaces",
  "weekday_start", "weekday_end", "saturday_start", "saturday_end",
  "holiday_start", "holiday_end", "is_free", "base_time", "base_fee",
  "extra_time", "extra_fee", "daily_max", "monthly_pass",
  "phone", "payment_methods", "notes",
];

function hasChanged(apiRow: DbRow, dbRow: DbRow): boolean {
  for (const field of COMPARE_FIELDS) {
    const a = apiRow[field];
    const b = dbRow[field];
    // 숫자는 문자열 변환 후 비교 (DB float 소수점 차이 방지)
    if (String(a ?? "") !== String(b ?? "")) return true;
  }
  return false;
}

// ── UPSERT SQL ──

function buildUpsert(row: DbRow): string {
  const cols = [
    "id", "name", "type", "address", "lat", "lng", "total_spaces",
    "weekday_start", "weekday_end", "saturday_start", "saturday_end",
    "holiday_start", "holiday_end", "is_free", "base_time", "base_fee",
    "extra_time", "extra_fee", "daily_max", "monthly_pass",
    "phone", "payment_methods", "notes",
  ];
  const vals = [
    `'${esc(row.id)}'`, `'${esc(row.name)}'`, `'${esc(row.type)}'`,
    `'${esc(row.address)}'`, row.lat, row.lng, row.total_spaces,
    `'${esc(row.weekday_start)}'`, `'${esc(row.weekday_end)}'`,
    `'${esc(row.saturday_start)}'`, `'${esc(row.saturday_end)}'`,
    `'${esc(row.holiday_start)}'`, `'${esc(row.holiday_end)}'`,
    row.is_free, row.base_time, row.base_fee,
    row.extra_time, row.extra_fee,
    row.daily_max ?? "NULL", row.monthly_pass ?? "NULL",
    `'${esc(row.phone)}'`, `'${esc(row.payment_methods)}'`, `'${esc(row.notes)}'`,
  ];

  const updateSet = cols
    .filter((c) => c !== "id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");

  return `INSERT INTO parking_lots (${cols.join(", ")}) VALUES (${vals.join(", ")}) ON CONFLICT(id) DO UPDATE SET ${updateSet}, updated_at = datetime('now');`;
}

// ── 유틸 ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 메인 ──

async function main() {
  console.log(`=== 공공데이터포털 주차장 동기화 ===`);
  console.log(`모드: ${DRY_RUN ? "DRY-RUN (DB 미반영)" : isRemote ? "REMOTE" : "LOCAL"}\n`);

  // 1. API 수집
  console.log("📡 API 데이터 수집 중...");
  const apiItems = await fetchAll();

  // 2. 파싱 + 유효성 검증
  const apiRows: DbRow[] = [];
  let skipped = 0;
  for (const item of apiItems) {
    const row = toDbRow(item);
    if (row) apiRows.push(row);
    else skipped++;
  }
  console.log(`파싱: ${apiRows.length}건 유효, ${skipped}건 스킵 (좌표 무효/ID 없음)\n`);

  // 3. DB 기존 공공데이터 주차장 조회
  console.log("💾 DB 기존 데이터 조회 중...");
  const dbRows = d1Query<DbRow>(
    `SELECT id, name, type, address, lat, lng, total_spaces,
            weekday_start, weekday_end, saturday_start, saturday_end,
            holiday_start, holiday_end, is_free, base_time, base_fee,
            extra_time, extra_fee, daily_max, monthly_pass,
            phone, payment_methods, notes
     FROM parking_lots
     WHERE id NOT LIKE 'KA-%' AND id NOT LIKE 'NV-%'`
  );
  const dbMap = new Map(dbRows.map((r) => [r.id, r]));
  console.log(`DB 공공데이터 주차장: ${dbRows.length}건\n`);

  // 4. 비교
  const newRows: DbRow[] = [];
  const changedRows: DbRow[] = [];
  let unchanged = 0;

  for (const apiRow of apiRows) {
    const dbRow = dbMap.get(apiRow.id);
    if (!dbRow) {
      newRows.push(apiRow);
    } else if (hasChanged(apiRow, dbRow)) {
      changedRows.push(apiRow);
    } else {
      unchanged++;
    }
    dbMap.delete(apiRow.id);
  }

  // dbMap에 남은 것 = API에 없는 기존 주차장 (폐쇄 의심)
  const missing = [...dbMap.values()];

  // 5. 리포트
  console.log("📊 비교 결과:");
  console.log(`  신규 추가: ${newRows.length}건`);
  console.log(`  정보 변경: ${changedRows.length}건`);
  console.log(`  동일 (스킵): ${unchanged}건`);
  console.log(`  폐쇄 의심 (API 미존재): ${missing.length}건`);
  console.log();

  if (missing.length > 0 && missing.length <= 20) {
    console.log("⚠️  폐쇄 의심 주차장:");
    for (const m of missing) {
      console.log(`  - ${m.id} ${m.name} (${m.address})`);
    }
    console.log();
  } else if (missing.length > 20) {
    console.log(`⚠️  폐쇄 의심 ${missing.length}건 (상위 20건):`);
    for (const m of missing.slice(0, 20)) {
      console.log(`  - ${m.id} ${m.name} (${m.address})`);
    }
    console.log(`  ... 외 ${missing.length - 20}건\n`);
  }

  const upsertRows = [...newRows, ...changedRows];
  if (upsertRows.length === 0) {
    console.log("✅ 변경사항 없음. 종료.");
    return;
  }

  if (DRY_RUN) {
    console.log(`🔍 DRY-RUN: ${upsertRows.length}건 UPSERT 예정 (DB 미반영)`);
    if (newRows.length <= 10) {
      for (const r of newRows) console.log(`  [신규] ${r.id} ${r.name}`);
    }
    if (changedRows.length <= 10) {
      for (const r of changedRows) console.log(`  [변경] ${r.id} ${r.name}`);
    }
    return;
  }

  // 6. UPSERT 실행
  console.log(`⚡ ${upsertRows.length}건 UPSERT 실행 중...`);
  const BATCH = 100;
  const tmpSql = resolve(import.meta.dir, "../.tmp-sync.sql");

  for (let i = 0; i < upsertRows.length; i += BATCH) {
    const slice = upsertRows.slice(i, i + BATCH);
    const stmts = slice.map(buildUpsert).join("\n");
    writeFileSync(tmpSql, stmts);
    d1ExecFile(tmpSql);

    const done = Math.min(i + BATCH, upsertRows.length);
    process.stdout.write(`\r  ${done}/${upsertRows.length} (${Math.round((done / upsertRows.length) * 100)}%)`);
  }

  try { unlinkSync(tmpSql); } catch {}
  console.log(`\n\n✅ 완료! ${upsertRows.length}건 UPSERT (신규 ${newRows.length} + 변경 ${changedRows.length})`);
}

main().catch((err) => {
  console.error("❌ 에러:", err.message ?? err);
  process.exit(1);
});
