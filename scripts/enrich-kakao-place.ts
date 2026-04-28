/**
 * Kakao Place 스크래핑으로 주차장 기본정보 보강
 * — 운영시간, 기본/추가 요금, 일 최대, 무료 여부, 전화 등 공식 데이터
 *
 * 대상: KA-xxx 주차장 (xxx = Kakao place ID)
 *
 * 사용법:
 *   bun run scripts/enrich-kakao-place.ts --lotIds=KA-1935812519,KA-381534316 --remote
 *   bun run scripts/enrich-kakao-place.ts --lotIds=... --remote --dry-run
 *
 *   # 배치 모드 (DB 자동 쿼리: KA-* + 노외 + 운영시간 누락)
 *   bun run scripts/enrich-kakao-place.ts --batch --limit=100 --dry-run
 *   bun run scripts/enrich-kakao-place.ts --batch --limit=500 --offset=100 --remote
 */
import { chromium, type Browser, type Page } from "playwright";
import { resolve } from "path";
import { readFileSync, writeFileSync } from "fs";
import { d1Query, d1ExecFile, isRemote } from "./lib/d1";
import { esc } from "./lib/sql-flush";

// ── CLI ──
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const BATCH_MODE = args.includes("--batch");
const lotIdsArg = args.find((a) => a.startsWith("--lotIds="))?.split("=")[1];
const limitArg = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
const BATCH_LIMIT = parseInt(limitArg ?? "100", 10);
const BATCH_OFFSET = parseInt(args.find((a) => a.startsWith("--offset="))?.split("=")[1] ?? "0", 10);
const CITY_FILTER = args.find((a) => a.startsWith("--city="))?.split("=")[1]; // 예: 서울,경기
const TARGETS_JSON = args.find((a) => a.startsWith("--targets-json="))?.split("=")[1];
const SQL_OUT = args.find((a) => a.startsWith("--sql-out="))?.split("=")[1];
const NO_APPLY = args.includes("--no-apply") || Boolean(SQL_OUT);

if (!BATCH_MODE && !lotIdsArg && !TARGETS_JSON) {
  console.error("--lotIds=id1,id2 또는 --batch 또는 --targets-json=파일 필수");
  process.exit(1);
}

let LOT_IDS: string[] = [];
let LOT_BY_ID = new Map<string, Lot>();
if (!BATCH_MODE && lotIdsArg) {
  LOT_IDS = lotIdsArg!.split(",").map((s) => s.trim()).filter(Boolean);
}

// ── 타입 ──
interface Lot {
  id: string;
  name: string;
  address: string | null;
  weekday_start: string | null;
  weekday_end: string | null;
  saturday_start: string | null;
  saturday_end: string | null;
  holiday_start: string | null;
  holiday_end: string | null;
  is_free: number;
  base_fee: number | null;
  total_spaces: number;
  phone: string | null;
  notes: string | null;
}

function loadTargetsJson(filePath: string): void {
  const lots = JSON.parse(readFileSync(filePath, "utf-8")) as Lot[];
  const selected = limitArg ? lots.slice(BATCH_OFFSET, BATCH_OFFSET + BATCH_LIMIT) : lots.slice(BATCH_OFFSET);
  LOT_BY_ID = new Map(selected.map((lot) => [lot.id, lot]));
  LOT_IDS = selected.map((lot) => lot.id);
}

// ── 통계 ──
interface Stats {
  total: number;
  scraped: number;          // 스크래핑 성공
  noSection: number;        // 카카오에 주차 섹션 없음
  parseFail: number;        // 섹션 있으나 파싱 결과 없음 (모두의주차장 등 미지원)
  updated: number;          // UPDATE 생성
  fieldHours: number;       // 운영시간 보강 건수
  fieldFee: number;         // 요금 보강 건수
  fieldDaily: number;       // 일 최대 보강 건수
}

interface PlaceInfo {
  operatingHours: Record<string, { start: string; end: string }> | null; // { weekday, saturday, holiday }
  baseTime: number | null;
  baseFee: number | null;
  extraTime: number | null;
  extraFee: number | null;
  dailyMax: number | null;
  isFreeCoupon: boolean; // "100% 무료" 쿠폰 있음
  notes: string | null;
  category: string | null;
}

// ── 유틸 ──
function parseTimeRange(text: string): { start: string; end: string } | null {
  const m = text.match(/(\d{2}):(\d{2})\s*~\s*(\d{2}):(\d{2})/);
  if (!m) return null;
  return { start: `${m[1]}:${m[2]}`, end: `${m[3]}:${m[4]}` };
}

function parseFeeWon(text: string): number | null {
  const m = text.match(/([\d,]+)\s*원/);
  if (!m) return null;
  return parseInt(m[1].replace(/,/g, ""), 10);
}

function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value === "" || value === "null";
}

// ── 스크래핑 ──
async function scrapeKakao(page: Page, placeId: string): Promise<PlaceInfo | null> {
  const url = `https://place.map.kakao.com/${placeId}`;
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
  } catch (e) {
    console.warn(`  ⚠ ${placeId} goto 실패: ${(e as Error).message.slice(0, 100)}`);
    return null;
  }

  return await page.evaluate(() => {
    const result = {
      category: null as string | null,
      hoursText: null as string | null, // "매일 10:00 ~ 22:00" or per-day
      perDayHours: {} as Record<string, string>, // { "금": "10:00 ~ 22:00", "토": ... }
      feeRows: [] as { label: string; amount: string }[],
      isFreeCoupon: false,
      notes: null as string | null,
    };

    // 카테고리
    const cate = document.querySelector(".info_cate");
    if (cate) {
      const txt = cate.textContent?.replace("장소 카테고리", "").trim() ?? null;
      result.category = txt;
    }

    // 주차정보 섹션 → 운영시간
    const parkingSection = document.querySelector(".section_airportParking, .cont_parking");
    if (parkingSection) {
      const descs = parkingSection.querySelectorAll(".list_desc");
      descs.forEach((dl) => {
        const dt = dl.querySelector("dt")?.textContent?.trim() ?? "";
        const dd = dl.querySelector("dd")?.textContent?.trim() ?? "";
        if (dt === "운영시간") result.hoursText = dd;
      });
      // 요금 테이블
      const rows = parkingSection.querySelectorAll(".tbl_comm tbody tr");
      rows.forEach((tr) => {
        const th = tr.querySelector("th")?.textContent?.trim() ?? "";
        const td = tr.querySelector("td")?.textContent?.trim() ?? "";
        if (th && td) result.feeRows.push({ label: th, amount: td });
      });
    }

    // 영업정보 per-day (fold_detail 있을 경우)
    const foldLines = document.querySelectorAll(".info_operation .line_fold");
    foldLines.forEach((line) => {
      const tit = line.querySelector(".tit_fold")?.textContent?.trim() ?? "";
      const val = line.querySelector(".txt_detail")?.textContent?.trim() ?? "";
      if (tit && val) {
        // "금(4/17)" → "금"
        const dayMatch = tit.match(/([월화수목금토일])/);
        if (dayMatch) result.perDayHours[dayMatch[1]] = val;
      }
    });

    // 100% 무료 쿠폰
    const discountLabels = Array.from(document.querySelectorAll(".section_discount .txt_box2")).map((el) => el.textContent?.trim() ?? "");
    if (discountLabels.some((t) => t.includes("100% 무료"))) result.isFreeCoupon = true;

    // 주요 특기사항 (있다면)
    const desc = document.querySelector(".desc_info")?.textContent?.trim() ?? null;
    if (desc && desc.length > 10 && desc.length < 200) result.notes = desc;

    return result;
  }).then((raw) => {
    // 운영시간 normalize
    let operatingHours: Record<string, { start: string; end: string }> | null = null;
    const dayMap: Record<string, "weekday" | "saturday" | "holiday"> = {
      월: "weekday", 화: "weekday", 수: "weekday", 목: "weekday", 금: "weekday",
      토: "saturday", 일: "holiday",
    };

    const collected: Record<string, { start: string; end: string }> = {};

    if (raw.hoursText) {
      const r = parseTimeRange(raw.hoursText);
      if (r) {
        collected.weekday = r;
        collected.saturday = r;
        collected.holiday = r;
      }
    }

    // per-day는 특정 요일만 다를 때 유용
    for (const [day, text] of Object.entries(raw.perDayHours)) {
      const r = parseTimeRange(text);
      const group = dayMap[day];
      if (r && group) collected[group] = r;
    }

    if (Object.keys(collected).length > 0) operatingHours = collected;

    // 요금 parsing
    let baseTime: number | null = null;
    let baseFee: number | null = null;
    let extraTime: number | null = null;
    let extraFee: number | null = null;
    let dailyMax: number | null = null;

    for (const row of raw.feeRows) {
      const won = parseFeeWon(row.amount);
      if (won === null) continue;
      const minMatch = row.label.match(/(\d+)\s*분/);
      if (row.label.startsWith("기본") && minMatch) {
        baseTime = parseInt(minMatch[1], 10);
        baseFee = won;
      } else if (row.label.startsWith("추가") && minMatch) {
        extraTime = parseInt(minMatch[1], 10);
        extraFee = won;
      } else if (row.label.includes("일 최대") || row.label.includes("일최대")) {
        dailyMax = won;
      } else if (minMatch && baseTime === null) {
        // 모두의주차장 포맷: th가 "30분", "1시간" 등 — 첫 번째 row를 기본요금으로 취급
        baseTime = parseInt(minMatch[1], 10);
        baseFee = won;
      } else if (row.label.match(/(\d+)\s*시간/) && baseTime !== null && extraTime === null) {
        // "1시간", "2시간" 등 두 번째 row — 추가요금 단위 역산
        const hrMatch = row.label.match(/(\d+)\s*시간/);
        if (hrMatch) {
          const hrs = parseInt(hrMatch[1], 10);
          // hrs시간 요금 - 기본요금 = 추가 (hrs*60 - baseTime)분 요금
          const addlMin = hrs * 60 - baseTime;
          const addlFee = won - baseFee!;
          if (addlMin > 0 && addlFee > 0) {
            extraTime = addlMin;
            extraFee = addlFee;
          }
        }
      }
    }

    return {
      operatingHours,
      baseTime,
      baseFee,
      extraTime,
      extraFee,
      dailyMax,
      isFreeCoupon: raw.isFreeCoupon,
      notes: raw.notes,
      category: raw.category,
    };
  });
}

// ── UPDATE SQL 빌더 (빈 필드만 채우는 보수적 모드) ──
function buildUpdate(lot: Lot, info: PlaceInfo): { sql: string | null; fields: string[] } {
  const sets: string[] = [];
  const fields: string[] = [];

  // 운영시간 — 현재 비어있을 때만 (각 요일 독립 체크)
  if (info.operatingHours) {
    if (isBlank(lot.weekday_start) && info.operatingHours.weekday) {
      sets.push(`weekday_start = '${esc(info.operatingHours.weekday.start)}'`);
      sets.push(`weekday_end = '${esc(info.operatingHours.weekday.end)}'`);
      fields.push("운영시간");
    }
    if (isBlank(lot.saturday_start) && info.operatingHours.saturday) {
      sets.push(`saturday_start = '${esc(info.operatingHours.saturday.start)}'`);
      sets.push(`saturday_end = '${esc(info.operatingHours.saturday.end)}'`);
    }
    if (isBlank(lot.holiday_start) && info.operatingHours.holiday) {
      sets.push(`holiday_start = '${esc(info.operatingHours.holiday.start)}'`);
      sets.push(`holiday_end = '${esc(info.operatingHours.holiday.end)}'`);
    }
  }

  // 요금 — 기존 값 없을 때만 채움
  if (info.baseFee !== null && lot.base_fee === null) {
    const allZero = info.baseFee === 0 && (info.extraFee === 0 || info.extraFee === null) && (info.dailyMax === 0 || info.dailyMax === null);
    if (allZero) {
      sets.push(`is_free = 1`);
      sets.push(`base_time = NULL, base_fee = NULL, extra_time = NULL, extra_fee = NULL, daily_max = NULL`);
      fields.push("무료확정");
    } else {
      sets.push(`is_free = 0`);
      if (info.baseTime !== null) sets.push(`base_time = ${info.baseTime}`);
      sets.push(`base_fee = ${info.baseFee}`);
      if (info.extraTime !== null) sets.push(`extra_time = ${info.extraTime}`);
      if (info.extraFee !== null) sets.push(`extra_fee = ${info.extraFee}`);
      if (info.dailyMax !== null) { sets.push(`daily_max = ${info.dailyMax}`); fields.push("일최대"); }
      fields.push("요금");
    }
  } else if (info.isFreeCoupon && lot.is_free === 0) {
    sets.push(`is_free = 1`);
    fields.push("무료쿠폰");
  }

  if (sets.length === 0) return { sql: null, fields: [] };
  sets.push("verified_source = 'kakao_detail'");
  sets.push("verified_at = datetime('now')");
  sets.push("updated_at = datetime('now')");
  return { sql: `UPDATE parking_lots SET ${sets.join(", ")} WHERE id = '${esc(lot.id)}';`, fields };
}

// ── 배치 대상 조회 ──
function fetchBatchTargets(): string[] {
  const cityConditions = CITY_FILTER
    ? CITY_FILTER.split(",").map((c) => `address LIKE '${c.trim()}%'`).join(" OR ")
    : "address LIKE '서울%' OR address LIKE '경기%' OR address LIKE '인천%' OR address LIKE '부산%' OR address LIKE '대구%' OR address IS NOT NULL";

  const rows = d1Query<{ id: string }>(`
    SELECT id FROM parking_lots
    WHERE id LIKE 'KA-%'
      AND type = '노외'
      AND (weekday_start IS NULL OR weekday_start = '')
      AND (${cityConditions})
    ORDER BY
      CASE
        WHEN address LIKE '서울%' THEN 1
        WHEN address LIKE '경기%' THEN 2
        WHEN address LIKE '인천%' THEN 3
        WHEN address LIKE '부산%' THEN 4
        WHEN address LIKE '대구%' THEN 5
        ELSE 6
      END, id
    LIMIT ${BATCH_LIMIT} OFFSET ${BATCH_OFFSET}
  `);
  return rows.map((r) => r.id);
}

function fetchLot(lotId: string): Lot | undefined {
  const cached = LOT_BY_ID.get(lotId);
  if (cached) return cached;

  return d1Query<Lot>(
    `SELECT id, name, address, weekday_start, weekday_end, saturday_start, saturday_end, holiday_start, holiday_end, is_free, base_fee, total_spaces, phone, notes FROM parking_lots WHERE id = '${esc(lotId)}'`,
  )[0];
}

// ── Main ──
async function main() {
  if (TARGETS_JSON) {
    loadTargetsJson(TARGETS_JSON);
    console.log(`=== Kakao Place 보강 [TARGETS JSON] === (${TARGETS_JSON})`);
    console.log(`대상 ${LOT_IDS.length}개\n`);
  } else if (BATCH_MODE) {
    console.log(`=== Kakao Place 보강 [BATCH] === (limit=${BATCH_LIMIT}, offset=${BATCH_OFFSET})`);
    LOT_IDS.push(...fetchBatchTargets());
    console.log(`배치 조회: ${LOT_IDS.length}건\n`);
  } else {
    console.log(`=== Kakao Place 보강 === (${DRY_RUN ? "DRY-RUN" : isRemote ? "REMOTE" : "LOCAL"})`);
    console.log(`대상 ${LOT_IDS.length}개\n`);
  }

  if (LOT_IDS.length === 0) {
    console.log("대상 없음");
    return;
  }

  const stats: Stats = { total: LOT_IDS.length, scraped: 0, noSection: 0, parseFail: 0, updated: 0, fieldHours: 0, fieldFee: 0, fieldDaily: 0 };
  let browser: Browser | null = null;
  const sqls: string[] = [];
  const noInfoIds: string[] = [];
  const parseFailIds: string[] = [];

  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });
    const page = await ctx.newPage();

    for (const lotId of LOT_IDS) {
      if (!lotId.startsWith("KA-")) {
        console.warn(`✗ ${lotId}: Kakao ID 아님, 건너뜀`);
        continue;
      }
      const placeId = lotId.slice(3);

      const lot = fetchLot(lotId);
      if (!lot) {
        console.warn(`✗ ${lotId}: 주차장 없음`);
        continue;
      }
      console.log(`▶ ${lot.name} (${lotId} → placeId ${placeId})`);

      const info = await scrapeKakao(page, placeId);
      if (!info) {
        console.log(`  스크래핑 실패\n`);
        stats.noSection++;
        noInfoIds.push(lotId);
        continue;
      }
      stats.scraped++;

      const hasAnyData = info.operatingHours || info.baseFee !== null || info.isFreeCoupon;
      if (!hasAnyData) {
        // 섹션은 있으나 파싱 결과 없음 (모두의주차장 등 미지원 포맷 포함)
        stats.parseFail++;
        parseFailIds.push(lotId);
      }

      const details: string[] = [];
      if (info.category) details.push(`cate: ${info.category}`);
      if (info.operatingHours?.weekday) details.push(`평일 ${info.operatingHours.weekday.start}~${info.operatingHours.weekday.end}`);
      if (info.operatingHours?.saturday) details.push(`토 ${info.operatingHours.saturday.start}~${info.operatingHours.saturday.end}`);
      if (info.operatingHours?.holiday) details.push(`공휴일 ${info.operatingHours.holiday.start}~${info.operatingHours.holiday.end}`);
      if (info.baseTime !== null) details.push(`기본 ${info.baseTime}분 ${info.baseFee}원`);
      if (info.dailyMax !== null) details.push(`일 최대 ${info.dailyMax}원`);
      if (info.isFreeCoupon) details.push("100%무료쿠폰");
      console.log(`  추출: ${details.join(" / ") || "(없음)"}`);

      const { sql, fields } = buildUpdate(lot, info);
      if (sql) {
        sqls.push(sql);
        stats.updated++;
        if (fields.includes("운영시간")) stats.fieldHours++;
        if (fields.includes("요금")) stats.fieldFee++;
        if (fields.includes("일최대")) stats.fieldDaily++;
        console.log(`  → UPDATE [${fields.join(", ")}]`);
      } else {
        console.log(`  → 변경 없음`);
      }
      console.log();
    }
  } finally {
    if (browser) await browser.close();
  }

  // ── 통계 출력 ──
  console.log("\n=== 결과 통계 ===");
  console.log(`전체 대상:   ${stats.total}건`);
  console.log(`스크래핑 성공: ${stats.scraped}건`);
  console.log(`섹션 없음:   ${stats.noSection}건  ${noInfoIds.length ? `[${noInfoIds.join(", ")}]` : ""}`);
  console.log(`파싱 실패:   ${stats.parseFail}건  ${parseFailIds.length ? `[${parseFailIds.join(", ")}]` : ""}`);
  console.log(`UPDATE 준비: ${stats.updated}건  (성공률 ${Math.round(stats.updated / stats.total * 100)}%)`);
  console.log(`  ▸ 운영시간: ${stats.fieldHours}건`);
  console.log(`  ▸ 요금:     ${stats.fieldFee}건`);
  console.log(`  ▸ 일최대:   ${stats.fieldDaily}건`);

  if (sqls.length === 0) {
    console.log("\n쓸 내용 없음");
    return;
  }

  if (DRY_RUN) {
    console.log(`\n[dry-run] UPDATE ${sqls.length}건:`);
    sqls.forEach((s, i) => console.log(`${i + 1}. ${s}`));
    return;
  }

  const tmpFile = SQL_OUT ? resolve(process.cwd(), SQL_OUT) : resolve(import.meta.dir, "../.tmp-kakao-enrich.sql");
  writeFileSync(tmpFile, sqls.join("\n") + "\n", "utf-8");
  if (NO_APPLY) {
    console.log(`\n✓ SQL 파일 생성: ${tmpFile} (${sqls.length}건)`);
    return;
  }

  console.log(`\n⚡ 파일 실행: ${tmpFile}`);
  d1ExecFile(tmpFile);
  console.log(`✓ ${sqls.length}건 반영 완료`);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
