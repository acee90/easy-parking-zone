/**
 * Kakao Place 스크래핑으로 주차장 기본정보 보강
 * — 운영시간, 기본/추가 요금, 일 최대, 무료 여부, 전화 등 공식 데이터
 *
 * 대상: KA-xxx 주차장 (xxx = Kakao place ID)
 *
 * 사용법:
 *   bun run scripts/enrich-kakao-place.ts --lotIds=KA-1935812519,KA-381534316 --remote
 *   bun run scripts/enrich-kakao-place.ts --lotIds=... --remote --dry-run
 */
import { chromium, type Browser, type Page } from "playwright";
import { resolve } from "path";
import { writeFileSync } from "fs";
import { d1Query, d1ExecFile, isRemote } from "./lib/d1";
import { esc } from "./lib/sql-flush";

// ── CLI ──
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const lotIdsArg = args.find((a) => a.startsWith("--lotIds="))?.split("=")[1];
if (!lotIdsArg) {
  console.error("--lotIds=id1,id2 필수");
  process.exit(1);
}
const LOT_IDS = lotIdsArg.split(",").map((s) => s.trim()).filter(Boolean);

// ── 타입 ──
interface Lot {
  id: string;
  name: string;
  weekday_start: string | null;
  weekday_end: string | null;
  is_free: number;
  base_fee: number | null;
  total_spaces: number;
  phone: string | null;
  notes: string | null;
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
function buildUpdate(lot: Lot, info: PlaceInfo): string | null {
  const sets: string[] = [];

  // 운영시간 — 현재 비어있을 때만
  if (info.operatingHours) {
    if ((!lot.weekday_start || lot.weekday_start === "") && info.operatingHours.weekday) {
      sets.push(`weekday_start = '${esc(info.operatingHours.weekday.start)}'`);
      sets.push(`weekday_end = '${esc(info.operatingHours.weekday.end)}'`);
    }
    if (info.operatingHours.saturday) {
      sets.push(`saturday_start = '${esc(info.operatingHours.saturday.start)}'`);
      sets.push(`saturday_end = '${esc(info.operatingHours.saturday.end)}'`);
    }
    if (info.operatingHours.holiday) {
      sets.push(`holiday_start = '${esc(info.operatingHours.holiday.start)}'`);
      sets.push(`holiday_end = '${esc(info.operatingHours.holiday.end)}'`);
    }
  }

  // 요금 — 카카오가 0원이면 무료
  if (info.baseFee !== null) {
    const allZero = info.baseFee === 0 && (info.extraFee === 0 || info.extraFee === null) && (info.dailyMax === 0 || info.dailyMax === null);
    if (allZero) {
      sets.push(`is_free = 1`);
      sets.push(`base_time = NULL, base_fee = NULL, extra_time = NULL, extra_fee = NULL, daily_max = NULL`);
    } else {
      sets.push(`is_free = 0`);
      if (info.baseTime !== null) sets.push(`base_time = ${info.baseTime}`);
      sets.push(`base_fee = ${info.baseFee}`);
      if (info.extraTime !== null) sets.push(`extra_time = ${info.extraTime}`);
      if (info.extraFee !== null) sets.push(`extra_fee = ${info.extraFee}`);
      if (info.dailyMax !== null) sets.push(`daily_max = ${info.dailyMax}`);
    }
  } else if (info.isFreeCoupon && lot.is_free === 0) {
    // 100% 무료 쿠폰 있고 현재 유료로 잘못 잡혀있으면 교정
    sets.push(`is_free = 1`);
  }

  // notes 병합 (기존 notes에 카카오 설명 추가 안함 — 중복 회피)

  if (sets.length === 0) return null;
  sets.push("verified_source = 'kakao_detail'");
  sets.push("verified_at = datetime('now')");
  sets.push("updated_at = datetime('now')");
  return `UPDATE parking_lots SET ${sets.join(", ")} WHERE id = '${esc(lot.id)}';`;
}

// ── Main ──
async function main() {
  console.log(`=== Kakao Place 보강 === (${DRY_RUN ? "DRY-RUN" : isRemote ? "REMOTE" : "LOCAL"})`);
  console.log(`대상 ${LOT_IDS.length}개: ${LOT_IDS.join(", ")}\n`);

  let browser: Browser | null = null;
  const sqls: string[] = [];

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

      const rows = d1Query<Lot>(
        `SELECT id, name, weekday_start, weekday_end, is_free, base_fee, total_spaces, phone, notes FROM parking_lots WHERE id = '${esc(lotId)}'`,
      );
      const lot = rows[0];
      if (!lot) {
        console.warn(`✗ ${lotId}: 주차장 없음`);
        continue;
      }
      console.log(`▶ ${lot.name} (${lotId} → placeId ${placeId})`);

      const info = await scrapeKakao(page, placeId);
      if (!info) {
        console.log(`  스크래핑 실패\n`);
        continue;
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

      const sql = buildUpdate(lot, info);
      if (sql) {
        sqls.push(sql);
        console.log(`  → UPDATE 준비`);
      } else {
        console.log(`  → 변경 없음`);
      }
      console.log();
    }
  } finally {
    if (browser) await browser.close();
  }

  if (sqls.length === 0) {
    console.log("쓸 내용 없음");
    return;
  }

  if (DRY_RUN) {
    console.log(`[dry-run] UPDATE ${sqls.length}건:`);
    sqls.forEach((s, i) => console.log(`${i + 1}. ${s}`));
    return;
  }

  const tmpFile = resolve(import.meta.dir, "../.tmp-kakao-enrich.sql");
  writeFileSync(tmpFile, sqls.join("\n") + "\n", "utf-8");
  console.log(`\n⚡ 파일 실행: ${tmpFile}`);
  d1ExecFile(tmpFile);
  console.log(`✓ ${sqls.length}건 반영 완료`);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
