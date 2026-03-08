/**
 * 카카오 데이터(KA-) ↔ 공공데이터 중복 주차장 병합 스크립트
 *
 * 보수적 머지 조건 (3가지 모두 충족):
 *   1. 같은 이름
 *   2. 좌표 근접 (200m 이내, ~0.002도)
 *   3. 정규화된 주소 동일
 *
 * 주소 정규화:
 *   - 공백 제거
 *   - "서울특별시"→"서울", "부산광역시"→"부산" 등 광역시/특별시 축약
 *   - "(동명)" 괄호 제거
 *   - 숫자 사이 하이픈/공백 정규화
 */

import { d1Query, d1Execute } from "./lib/d1";

// ── 주소 정규화 ──
function normalizeAddress(addr: string): string {
  let s = addr;
  // 광역시/특별시/도 축약
  s = s.replace(/서울특별시/g, "서울");
  s = s.replace(/부산광역시/g, "부산");
  s = s.replace(/대구광역시/g, "대구");
  s = s.replace(/인천광역시/g, "인천");
  s = s.replace(/광주광역시/g, "광주");
  s = s.replace(/대전광역시/g, "대전");
  s = s.replace(/울산광역시/g, "울산");
  s = s.replace(/세종특별자치시/g, "세종");
  s = s.replace(/제주특별자치도/g, "제주");
  s = s.replace(/경기도/g, "경기");
  s = s.replace(/강원특별자치도/g, "강원");
  s = s.replace(/강원도/g, "강원");
  s = s.replace(/충청북도/g, "충북");
  s = s.replace(/충청남도/g, "충남");
  s = s.replace(/전라북도/g, "전북");
  s = s.replace(/전북특별자치도/g, "전북");
  s = s.replace(/전라남도/g, "전남");
  s = s.replace(/경상북도/g, "경북");
  s = s.replace(/경상남도/g, "경남");
  // 괄호 안 동명 제거: "서문로 16 (서귀동)" → "서문로 16"
  s = s.replace(/\s*\([^)]*\)\s*/g, "");
  // 모든 공백 제거
  s = s.replace(/\s+/g, "");
  return s;
}

// ── 메인 로직 ──

interface PairRow {
  pub_id: string;
  pub_name: string;
  pub_addr: string;
  pub_lat: number;
  pub_lng: number;
  pub_weekday_start: string;
  pub_weekday_end: string;
  pub_saturday_start: string;
  pub_saturday_end: string;
  pub_holiday_start: string;
  pub_holiday_end: string;
  pub_base_time: number | null;
  pub_base_fee: number | null;
  pub_extra_time: number | null;
  pub_extra_fee: number | null;
  pub_daily_max: number | null;
  pub_phone: string | null;
  pub_total_spaces: number;
  ka_id: string;
  ka_addr: string;
  ka_lat: number;
  ka_lng: number;
  ka_weekday_start: string;
  ka_weekday_end: string;
  ka_saturday_start: string;
  ka_saturday_end: string;
  ka_holiday_start: string;
  ka_holiday_end: string;
  ka_base_time: number | null;
  ka_base_fee: number | null;
  ka_extra_time: number | null;
  ka_extra_fee: number | null;
  ka_daily_max: number | null;
  ka_phone: string | null;
  ka_total_spaces: number;
}

console.log("=== 카카오-공공데이터 중복 주차장 병합 ===\n");

// 1) 이름 + 좌표 근접한 카카오-공공 후보 쌍 조회
const candidates = d1Query<PairRow>(`
  SELECT
    a.id as pub_id, a.name as pub_name, a.address as pub_addr,
    a.lat as pub_lat, a.lng as pub_lng,
    a.weekday_start as pub_weekday_start, a.weekday_end as pub_weekday_end,
    a.saturday_start as pub_saturday_start, a.saturday_end as pub_saturday_end,
    a.holiday_start as pub_holiday_start, a.holiday_end as pub_holiday_end,
    a.base_time as pub_base_time, a.base_fee as pub_base_fee,
    a.extra_time as pub_extra_time, a.extra_fee as pub_extra_fee,
    a.daily_max as pub_daily_max, a.phone as pub_phone,
    a.total_spaces as pub_total_spaces,
    b.id as ka_id, b.address as ka_addr,
    b.lat as ka_lat, b.lng as ka_lng,
    b.weekday_start as ka_weekday_start, b.weekday_end as ka_weekday_end,
    b.saturday_start as ka_saturday_start, b.saturday_end as ka_saturday_end,
    b.holiday_start as ka_holiday_start, b.holiday_end as ka_holiday_end,
    b.base_time as ka_base_time, b.base_fee as ka_base_fee,
    b.extra_time as ka_extra_time, b.extra_fee as ka_extra_fee,
    b.daily_max as ka_daily_max, b.phone as ka_phone,
    b.total_spaces as ka_total_spaces
  FROM parking_lots a
  JOIN parking_lots b
    ON a.name = b.name
    AND a.id NOT LIKE 'KA-%'
    AND b.id LIKE 'KA-%'
    AND ABS(a.lat - b.lat) < 0.002
    AND ABS(a.lng - b.lng) < 0.002
`);

console.log(`후보 쌍 (이름+좌표 근접): ${candidates.length}개`);

// 2) 정규화 주소 비교로 필터
const mergeTargets = candidates.filter((row) => {
  const normPub = normalizeAddress(row.pub_addr);
  const normKa = normalizeAddress(row.ka_addr);
  return normPub === normKa;
});

console.log(`주소 정규화 일치: ${mergeTargets.length}개`);
console.log(`제외 (주소 불일치): ${candidates.length - mergeTargets.length}개\n`);

// 3) 병합 실행
let mergedCount = 0;
let crawledReassigned = 0;
let reviewsReassigned = 0;
let infoUpdated = 0;

for (const row of mergeTargets) {
  // 3a) crawled_reviews 재매핑
  const crCount = d1Query<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM crawled_reviews WHERE parking_lot_id = '${row.ka_id}'`
  )[0]?.cnt ?? 0;

  if (crCount > 0) {
    d1Execute(
      `UPDATE crawled_reviews SET parking_lot_id = '${row.pub_id}' WHERE parking_lot_id = '${row.ka_id}'`
    );
    crawledReassigned += crCount;
  }

  // 3b) reviews 재매핑
  const rvCount = d1Query<{ cnt: number }>(
    `SELECT COUNT(*) as cnt FROM reviews WHERE parking_lot_id = '${row.ka_id}'`
  )[0]?.cnt ?? 0;

  if (rvCount > 0) {
    d1Execute(
      `UPDATE reviews SET parking_lot_id = '${row.pub_id}' WHERE parking_lot_id = '${row.ka_id}'`
    );
    reviewsReassigned += rvCount;
  }

  // 3c) 공공데이터 정보 보완 (빈 값이면 카카오에서 가져오기)
  const updates: string[] = [];

  // 운영시간: 공공데이터가 "00:00"이면 카카오 값으로 보완
  if (row.pub_weekday_start === "00:00" && row.ka_weekday_start !== "00:00") {
    updates.push(`weekday_start = '${row.ka_weekday_start}'`);
    updates.push(`weekday_end = '${row.ka_weekday_end}'`);
  }
  if (row.pub_saturday_start === "00:00" && row.ka_saturday_start !== "00:00") {
    updates.push(`saturday_start = '${row.ka_saturday_start}'`);
    updates.push(`saturday_end = '${row.ka_saturday_end}'`);
  }
  if (row.pub_holiday_start === "00:00" && row.ka_holiday_start !== "00:00") {
    updates.push(`holiday_start = '${row.ka_holiday_start}'`);
    updates.push(`holiday_end = '${row.ka_holiday_end}'`);
  }

  // 요금: 공공데이터가 null/0이면 카카오 값으로 보완
  if (!row.pub_base_time && row.ka_base_time) updates.push(`base_time = ${row.ka_base_time}`);
  if (!row.pub_base_fee && row.ka_base_fee) updates.push(`base_fee = ${row.ka_base_fee}`);
  if (!row.pub_extra_time && row.ka_extra_time) updates.push(`extra_time = ${row.ka_extra_time}`);
  if (!row.pub_extra_fee && row.ka_extra_fee) updates.push(`extra_fee = ${row.ka_extra_fee}`);
  if (!row.pub_daily_max && row.ka_daily_max) updates.push(`daily_max = ${row.ka_daily_max}`);

  // 전화번호
  if (!row.pub_phone && row.ka_phone) updates.push(`phone = '${row.ka_phone}'`);

  // 주차면수: 공공 0이면 카카오 값
  if (row.pub_total_spaces === 0 && row.ka_total_spaces > 0) {
    updates.push(`total_spaces = ${row.ka_total_spaces}`);
  }

  if (updates.length > 0) {
    d1Execute(`UPDATE parking_lots SET ${updates.join(", ")} WHERE id = '${row.pub_id}'`);
    infoUpdated++;
  }

  // 3d) 카카오 항목 삭제
  d1Execute(`DELETE FROM parking_lots WHERE id = '${row.ka_id}'`);
  mergedCount++;
}

// 4) 결과 요약
const afterTotal = d1Query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM parking_lots")[0]?.cnt ?? 0;
const afterKa = d1Query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM parking_lots WHERE id LIKE 'KA-%'")[0]?.cnt ?? 0;

const report = `# 중복 주차장 병합 결과 (1차 - 보수적)

## 머지 조건
- 같은 이름 (exact match)
- 좌표 근접 (위도/경도 차이 < 0.002, 약 200m)
- **정규화된 주소 동일** (공백 제거, 광역시/도 축약, 괄호 동명 제거)

## 주소 정규화 규칙
| 원본 | 정규화 |
|------|--------|
| 서울특별시 | 서울 |
| 부산광역시 | 부산 |
| (서귀동) 등 괄호 | 제거 |
| 공백 | 모두 제거 |

## 실행 결과

| 항목 | 값 |
|------|-----|
| 후보 쌍 (이름+좌표) | ${candidates.length}개 |
| 주소 정규화 일치 | ${mergeTargets.length}개 |
| 주소 불일치 (보류) | ${candidates.length - mergeTargets.length}개 |
| **실제 병합** | **${mergedCount}개** |
| crawled_reviews 재매핑 | ${crawledReassigned}건 |
| reviews 재매핑 | ${reviewsReassigned}건 |
| 정보 보완 (운영시간/요금 등) | ${infoUpdated}개 |

## 병합 후 현황

| 항목 | 값 |
|------|-----|
| 전체 주차장 | ${afterTotal}개 |
| 카카오 출처 (KA-) | ${afterKa}개 |
| 공공데이터 출처 | ${afterTotal - afterKa}개 |

## 미처리 항목 (주소 불일치)

이름과 좌표는 근접하나 정규화 주소가 다른 경우입니다.
도로명 vs 지번 차이, 번지 차이 등으로 보수적 기준에서 제외되었습니다.

| 공공ID | 이름 | 공공주소 | 카카오주소 |
|--------|------|----------|------------|
${candidates
  .filter((r) => normalizeAddress(r.pub_addr) !== normalizeAddress(r.ka_addr))
  .slice(0, 30)
  .map((r) => `| ${r.pub_id} | ${r.pub_name} | ${r.pub_addr} | ${r.ka_addr} |`)
  .join("\n")}
${candidates.length - mergeTargets.length > 30 ? `\n... 외 ${candidates.length - mergeTargets.length - 30}건\n` : ""}

## 다음 단계 제안
1. **주소 불일치 항목 추가 머지**: 도로명↔지번 변환 또는 더 느슨한 주소 비교
2. **공공데이터 내 자체 중복**: KA- 없이 공공데이터끼리 중복인 607쌍도 검토 필요
3. **원격 DB 반영**: \`--remote\` 플래그로 프로덕션 D1에도 동일 작업 실행
`;

// 보고서 저장
import { writeFileSync } from "fs";
writeFileSync("/Users/junhee/Documents/projects/parking-map/docs/merge-duplicates-report.md", report);

console.log("\n=== 결과 요약 ===");
console.log(`병합 완료: ${mergedCount}개`);
console.log(`crawled_reviews 재매핑: ${crawledReassigned}건`);
console.log(`reviews 재매핑: ${reviewsReassigned}건`);
console.log(`정보 보완: ${infoUpdated}개`);
console.log(`\n병합 후 전체 주차장: ${afterTotal}개 (카카오: ${afterKa}개)`);
console.log(`\n보고서: docs/merge-duplicates-report.md`);
