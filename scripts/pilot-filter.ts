/**
 * 필터링 파일럿: AI 매칭 전 스크립트 필터링 로직 검증
 *
 * 각 필터 단계별 생존율 측정 + 제거된 항목 샘플 출력.
 * 기존 파일럿 80건(원문 수집 완료분) + DB 전체 통계로 검증.
 *
 * 필터 단계:
 *   1. is_ad=1 제거
 *   2. 본문 100자 미만 제거
 *   3. "주차"/"parking" 키워드 미포함 제거
 *   4. 5km 이내 DB 주차장 후보 0건 제거
 *
 * Usage:
 *   bun run scripts/pilot-filter.ts --remote
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { d1Query, isRemote } from "./lib/d1";

const DIR = resolve(import.meta.dir);
const PILOT_RESULT = resolve(DIR, "pilot-fulltext-result-v2.json");
const OUTPUT_FILE = resolve(DIR, "pilot-filter-result.json");

// ─── 타입 ──────────────────────────────────────────────
interface PilotItem {
  id: number;
  sourceUrl: string;
  currentLotId: string;
  currentLotName: string;
  fullText: string | null;
  fullTextLength: number;
  fetchError: string | null;
  matches: Array<{ lotId: string; lotName: string }>;
}

interface ParkingLot {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

interface WebSourceRow {
  id: number;
  source: string;
  is_ad: number;
  content_length: number;
  has_parking_keyword: number;
}

interface FilterResult {
  id: number;
  sourceUrl: string;
  currentLotName: string;
  fullTextLength: number;
  filters: {
    isAd: boolean;
    tooShort: boolean;
    noParkingKeyword: boolean;
    noNearbyLots: boolean;
  };
  survived: boolean;
  removedBy: string | null;
}

// ─── Haversine ──────────────────────────────────────────
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── 주차 키워드 판정 ──────────────────────────────────────
const PARKING_KEYWORDS = [
  "주차", "parking", "주차장", "주차비", "주차요금", "주차면", "주차칸",
  "발렛", "기계식", "자주식", "무료주차", "유료주차", "주차타워",
];

function hasParkingKeyword(text: string): boolean {
  const lower = text.toLowerCase();
  return PARKING_KEYWORDS.some((kw) => lower.includes(kw));
}

// ─── 메인 ───────────────────────────────────────────────
async function main() {
  console.log(`[Filter Pilot] ${isRemote ? "REMOTE" : "LOCAL"} DB\n`);

  // ═══════════════════════════════════════════════════════
  // Part 1: DB 전체 통계 (필터 1,4 시뮬레이션)
  // ═══════════════════════════════════════════════════════
  console.log("═══ Part 1: DB 전체 통계 ═══\n");

  const totalStats = d1Query<{ source: string; cnt: number; ad_cnt: number }>(
    "SELECT source, COUNT(*) as cnt, SUM(CASE WHEN is_ad = 1 THEN 1 ELSE 0 END) as ad_cnt FROM web_sources GROUP BY source ORDER BY cnt DESC"
  );

  let totalAll = 0;
  let totalAd = 0;
  console.log("  소스별 현황:");
  for (const row of totalStats) {
    console.log(`    ${row.source}: ${row.cnt}건 (광고 ${row.ad_cnt}건, ${((row.ad_cnt / row.cnt) * 100).toFixed(1)}%)`);
    totalAll += row.cnt;
    totalAd += row.ad_cnt;
  }
  console.log(`    ─────────────────────────`);
  console.log(`    합계: ${totalAll}건 (광고 ${totalAd}건)\n`);

  // snippet 기준 주차 키워드 포함 여부 (DB content = snippet ~200자)
  const kwStats = d1Query<{ has_kw: number; cnt: number }>(
    "SELECT CASE WHEN (content LIKE '%주차%' OR content LIKE '%parking%' OR content LIKE '%발렛%' OR content LIKE '%기계식%') THEN 1 ELSE 0 END as has_kw, COUNT(*) as cnt FROM web_sources WHERE is_ad = 0 GROUP BY has_kw"
  );

  console.log("  주차 키워드 포함 (snippet 기준, 광고 제외):");
  for (const row of kwStats) {
    console.log(`    ${row.has_kw ? "포함" : "미포함"}: ${row.cnt}건`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════
  // Part 2: 파일럿 80건 원문 기반 필터 검증
  // ═══════════════════════════════════════════════════════
  console.log("═══ Part 2: 파일럿 80건 원문 기반 필터 검증 ═══\n");

  if (!existsSync(PILOT_RESULT)) {
    console.error(`${PILOT_RESULT} 없음. pilot-poi-fulltext.ts를 먼저 실행하세요.`);
    process.exit(1);
  }

  const pilotItems: PilotItem[] = JSON.parse(readFileSync(PILOT_RESULT, "utf-8"));
  console.log(`  파일럿 데이터: ${pilotItems.length}건\n`);

  // is_ad 상태 조회
  const pilotIds = pilotItems.map((p) => p.id);
  const adRows = d1Query<{ id: number; is_ad: number }>(
    `SELECT id, is_ad FROM web_sources WHERE id IN (${pilotIds.join(",")})`
  );
  const adMap = new Map(adRows.map((r) => [r.id, r.is_ad === 1]));

  // 좌표 정보 (샘플 파일에서)
  const sampleFile = resolve(DIR, "pilot-fulltext-sample-v2.json");
  const samples: Array<{ id: number; lot_lat: number; lot_lng: number }> = existsSync(sampleFile)
    ? JSON.parse(readFileSync(sampleFile, "utf-8"))
    : [];
  const coordMap = new Map(samples.map((s) => [s.id, { lat: s.lot_lat, lng: s.lot_lng }]));

  // DB 주차장 전체 로드 (근접 후보 확인용)
  console.log("  DB 주차장 로드 중...");
  const allLots = d1Query<ParkingLot>("SELECT id, name, lat, lng FROM parking_lots");
  console.log(`  ${allLots.length}개 주차장\n`);

  // 필터 적용
  const results: FilterResult[] = [];
  const funnelCounts = {
    total: 0,
    afterAd: 0,
    afterLength: 0,
    afterKeyword: 0,
    afterNearby: 0,
  };

  // 제거 사유별 샘플 수집
  const removedSamples: Record<string, Array<{ id: number; url: string; lot: string; preview: string }>> = {
    isAd: [],
    tooShort: [],
    noParkingKeyword: [],
    noNearbyLots: [],
  };

  for (const item of pilotItems) {
    funnelCounts.total++;

    const isAd = adMap.get(item.id) ?? false;
    const tooShort = (item.fullTextLength ?? 0) < 100;
    const noParkingKeyword = item.fullText ? !hasParkingKeyword(item.fullText) : true;

    // 근접 주차장 후보 확인 (5km 이내)
    const coord = coordMap.get(item.id);
    let nearbyCount = 0;
    if (coord) {
      nearbyCount = allLots.filter(
        (l) => haversineKm(coord.lat, coord.lng, l.lat, l.lng) <= 5
      ).length;
    }
    const noNearbyLots = nearbyCount === 0;

    // 순차 필터 (첫 번째 걸리는 필터에서 제거)
    let removedBy: string | null = null;
    if (isAd) {
      removedBy = "isAd";
    } else {
      funnelCounts.afterAd++;
      if (tooShort) {
        removedBy = "tooShort";
      } else {
        funnelCounts.afterLength++;
        if (noParkingKeyword) {
          removedBy = "noParkingKeyword";
        } else {
          funnelCounts.afterKeyword++;
          if (noNearbyLots) {
            removedBy = "noNearbyLots";
          } else {
            funnelCounts.afterNearby++;
          }
        }
      }
    }

    const survived = removedBy === null;
    const preview = (item.fullText ?? "").slice(0, 150).replace(/\n/g, " ");

    if (removedBy && removedSamples[removedBy].length < 5) {
      removedSamples[removedBy].push({
        id: item.id,
        url: item.sourceUrl,
        lot: item.currentLotName,
        preview,
      });
    }

    results.push({
      id: item.id,
      sourceUrl: item.sourceUrl,
      currentLotName: item.currentLotName,
      fullTextLength: item.fullTextLength,
      filters: { isAd, tooShort, noParkingKeyword, noNearbyLots },
      survived,
      removedBy,
    });
  }

  // ═══════════════════════════════════════════════════════
  // 퍼널 리포트
  // ═══════════════════════════════════════════════════════
  console.log("═══ 필터 퍼널 (파일럿 80건) ═══\n");
  const f = funnelCounts;
  console.log(`  전체              : ${f.total}건`);
  console.log(`  ↓ is_ad 제거 후   : ${f.afterAd}건 (-${f.total - f.afterAd})`);
  console.log(`  ↓ 100자 미만 제거 : ${f.afterLength}건 (-${f.afterAd - f.afterLength})`);
  console.log(`  ↓ 주차키워드 없음 : ${f.afterKeyword}건 (-${f.afterLength - f.afterKeyword})`);
  console.log(`  ↓ 근접 후보 없음  : ${f.afterNearby}건 (-${f.afterKeyword - f.afterNearby})`);
  console.log(`  ────────────────────────────`);
  console.log(`  최종 생존: ${f.afterNearby}건 (${((f.afterNearby / f.total) * 100).toFixed(1)}%)\n`);

  // 제거 사유별 샘플 출력
  console.log("═══ 제거된 항목 샘플 (수동 검증용) ═══\n");
  for (const [reason, items] of Object.entries(removedSamples)) {
    if (items.length === 0) continue;
    console.log(`  [${reason}] ${items.length}건 샘플:`);
    for (const item of items) {
      console.log(`    #${item.id} ${item.lot}`);
      console.log(`      URL: ${item.url}`);
      console.log(`      내용: "${item.preview.slice(0, 100)}..."`);
    }
    console.log();
  }

  // 생존 항목 중 AI 매칭과의 교차 검증 (pilot-ai-match-result.json 있으면)
  const aiResultFile = resolve(DIR, "pilot-ai-match-result.json");
  if (existsSync(aiResultFile)) {
    console.log("═══ 필터 vs AI 매칭 교차 검증 ═══\n");
    const aiResults: Array<{
      id: number;
      aiMatches: Array<{ lotId: string; confidence: string }>;
    }> = JSON.parse(readFileSync(aiResultFile, "utf-8"));
    const aiMap = new Map(aiResults.map((r) => [r.id, r]));

    let filterPassAiMatch = 0;   // 필터 통과 + AI 매칭 있음
    let filterPassAiEmpty = 0;   // 필터 통과 + AI 매칭 없음
    let filterBlockAiMatch = 0;  // 필터 제거 + AI 매칭 있었음 (false negative!)
    let filterBlockAiEmpty = 0;  // 필터 제거 + AI 매칭 없었음 (true negative)

    for (const r of results) {
      const ai = aiMap.get(r.id);
      if (!ai) continue;

      const aiHasMatch = ai.aiMatches.length > 0;
      if (r.survived && aiHasMatch) filterPassAiMatch++;
      else if (r.survived && !aiHasMatch) filterPassAiEmpty++;
      else if (!r.survived && aiHasMatch) filterBlockAiMatch++;
      else filterBlockAiEmpty++;
    }

    console.log(`  필터 통과 + AI 매칭 O : ${filterPassAiMatch}건 (정상)`);
    console.log(`  필터 통과 + AI 매칭 X : ${filterPassAiEmpty}건 (AI에서 제거됨, OK)`);
    console.log(`  필터 제거 + AI 매칭 O : ${filterBlockAiMatch}건 ⚠️ (FALSE NEGATIVE — 필터가 유효 글 제거!)`);
    console.log(`  필터 제거 + AI 매칭 X : ${filterBlockAiEmpty}건 (정상 제거)\n`);

    // false negative 상세
    if (filterBlockAiMatch > 0) {
      console.log("  ⚠️ FALSE NEGATIVE 상세:");
      for (const r of results) {
        if (r.survived) continue;
        const ai = aiMap.get(r.id);
        if (!ai || ai.aiMatches.length === 0) continue;

        const aiLots = ai.aiMatches.map((m) => `${m.lotId}(${m.confidence})`).join(", ");
        console.log(`    #${r.id} ${r.currentLotName} — 제거사유: ${r.removedBy}`);
        console.log(`      AI 매칭: ${aiLots}`);
      }
      console.log();
    }
  }

  // 저장
  writeFileSync(OUTPUT_FILE, JSON.stringify({ funnelCounts, results, removedSamples }, null, 2));
  console.log(`[Filter Pilot] 결과 저장 → ${OUTPUT_FILE}`);
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
