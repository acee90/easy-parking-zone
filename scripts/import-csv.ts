/**
 * 전국주차장정보표준데이터.csv → D1 import
 *
 * 사용법: bun run import-csv
 * (wrangler d1 migrations apply parking-db --local 선행 필요)
 *
 * - EUC-KR → UTF-8 변환
 * - 위도/경도 없는 행 스킵
 * - 주차장유형 매핑: 노상/노외/부설
 * - D1 batch insert (500건씩)
 */
import { readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { d1ExecFile } from "./lib/d1";
import { esc } from "./lib/sql-flush";

const CSV_PATH = resolve(
  import.meta.dir,
  "../전국주차장정보표준데이터.csv"
);

// EUC-KR → UTF-8
const raw = readFileSync(CSV_PATH);
const text = new TextDecoder("euc-kr").decode(raw);
const lines = text.split("\n").filter((l) => l.trim());

const header = lines[0].split(",");
console.log(`CSV 컬럼 수: ${header.length}, 총 행: ${lines.length - 1}`);

// 컬럼 인덱스 매핑
const col = (name: string) => {
  const idx = header.indexOf(name);
  if (idx === -1) throw new Error(`컬럼 '${name}' 없음`);
  return idx;
};

const COL = {
  id: col("주차장관리번호"),
  name: col("주차장명"),
  division: col("주차장구분"),
  type: col("주차장유형"),
  roadAddr: col("소재지도로명주소"),
  lotAddr: col("소재지지번주소"),
  spaces: col("주차구획수"),
  weekdayStart: col("평일운영시작시각"),
  weekdayEnd: col("평일운영종료시각"),
  satStart: col("토요일운영시작시각"),
  satEnd: col("토요일운영종료시각"),
  holStart: col("공휴일운영시작시각"),
  holEnd: col("공휴일운영종료시각"),
  feeInfo: col("요금정보"),
  baseTime: col("주차기본시간"),
  baseFee: col("주차기본요금"),
  extraTime: col("추가단위시간"),
  extraFee: col("추가단위요금"),
  dailyMax: col("1일주차권요금"),
  monthlyPass: col("월정기권요금"),
  payment: col("결제방법"),
  notes: col("특기사항"),
  phone: col("전화번호"),
  lat: col("위도"),
  lng: col("경도"),
};

// CSV 파싱 (간단한 quoted field 지원)
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      fields.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current.trim());
  return fields;
}

function mapType(csvType: string): string {
  if (csvType.includes("노상")) return "노상";
  if (csvType.includes("노외")) return "노외";
  if (csvType.includes("부설")) return "부설";
  return csvType || "노외";
}

interface Row {
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

const rows: Row[] = [];
let skipped = 0;

for (let i = 1; i < lines.length; i++) {
  const fields = parseCSVLine(lines[i]);
  if (fields.length < header.length) {
    skipped++;
    continue;
  }

  const lat = parseFloat(fields[COL.lat]);
  const lng = parseFloat(fields[COL.lng]);
  if (!lat || !lng || lat < 33 || lat > 39 || lng < 124 || lng > 132) {
    skipped++;
    continue;
  }

  const id = fields[COL.id];
  if (!id) {
    skipped++;
    continue;
  }

  const name = fields[COL.name] || "이름없음";
  const type = mapType(fields[COL.type]);
  const address = fields[COL.roadAddr] || fields[COL.lotAddr] || "";
  const totalSpaces = parseInt(fields[COL.spaces]) || 0;
  const notes = fields[COL.notes] || "";

  rows.push({
    id,
    name,
    type,
    address,
    lat,
    lng,
    total_spaces: totalSpaces,
    weekday_start: fields[COL.weekdayStart] || "00:00",
    weekday_end: fields[COL.weekdayEnd] || "00:00",
    saturday_start: fields[COL.satStart] || "00:00",
    saturday_end: fields[COL.satEnd] || "00:00",
    holiday_start: fields[COL.holStart] || "00:00",
    holiday_end: fields[COL.holEnd] || "00:00",
    is_free: fields[COL.feeInfo] === "무료" ? 1 : 0,
    base_time: parseInt(fields[COL.baseTime]) || 0,
    base_fee: parseInt(fields[COL.baseFee]) || 0,
    extra_time: parseInt(fields[COL.extraTime]) || 0,
    extra_fee: parseInt(fields[COL.extraFee]) || 0,
    daily_max: parseInt(fields[COL.dailyMax]) || null,
    monthly_pass: parseInt(fields[COL.monthlyPass]) || null,
    phone: fields[COL.phone] || "",
    payment_methods: fields[COL.payment] || "",
    notes,
  });
}

console.log(`파싱 완료: ${rows.length}건 유효, ${skipped}건 스킵 (좌표없음/파싱실패)`);

// SQL 파일 생성 후 --file로 실행 (--command 크기 제한 우회)
const BATCH = 100;
const batches = Math.ceil(rows.length / BATCH);
const tmpSql = resolve(import.meta.dir, "../.tmp-import.sql");

// 먼저 기존 데이터 삭제
writeFileSync(tmpSql, "DELETE FROM parking_lots;\n");
d1ExecFile(tmpSql);

for (let b = 0; b < batches; b++) {
  const slice = rows.slice(b * BATCH, (b + 1) * BATCH);
  const stmts = slice
    .map(
      (r) =>
        `INSERT OR REPLACE INTO parking_lots (id,name,type,address,lat,lng,total_spaces,free_spaces,weekday_start,weekday_end,saturday_start,saturday_end,holiday_start,holiday_end,is_free,base_time,base_fee,extra_time,extra_fee,daily_max,monthly_pass,phone,payment_methods,notes) VALUES ('${esc(r.id)}','${esc(r.name)}','${esc(r.type)}','${esc(r.address)}',${r.lat},${r.lng},${r.total_spaces},NULL,'${r.weekday_start}','${r.weekday_end}','${r.saturday_start}','${r.saturday_end}','${r.holiday_start}','${r.holiday_end}',${r.is_free},${r.base_time},${r.base_fee},${r.extra_time},${r.extra_fee},${r.daily_max ?? "NULL"},${r.monthly_pass ?? "NULL"},'${esc(r.phone)}','${esc(r.payment_methods)}','${esc(r.notes)}');`
    )
    .join("\n");

  writeFileSync(tmpSql, stmts);
  d1ExecFile(tmpSql);

  const done = Math.min((b + 1) * BATCH, rows.length);
  process.stdout.write(`\r  ${done}/${rows.length} (${Math.round((done / rows.length) * 100)}%)`);
}

unlinkSync(tmpSql);
console.log(`\n완료! 총 ${rows.length}건 import.`);
