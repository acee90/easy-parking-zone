/**
 * 필터 v2 평가: 저장된 데이터로 필터 로직 반복 검증
 *
 * pilot-filter-v2-data.json (AI 매칭 답지 포함)을 로드하여
 * 필터 설정을 바꿔가며 precision/recall 측정.
 *
 * API 호출 없음 — 무비용으로 반복 실행 가능.
 *
 * Usage:
 *   bun run scripts/pilot-filter-v2-eval.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const DIR = resolve(import.meta.dir);
const DATA_FILE = resolve(DIR, "pilot-filter-v2-data.json");

// ─── 타입 ──────────────────────────────────────────────
interface CollectedItem {
  id: number;
  source: string;
  sourceUrl: string;
  title: string;
  snippet: string;
  parkingLotId: string;
  lotName: string;
  lotLat: number;
  lotLng: number;
  isAd: boolean;
  fullText: string | null;
  fullTextLength: number;
  fetchError: string | null;
  nearbyLotCount: number;
  aiMatches: Array<{
    lotId: string;
    lotName: string;
    confidence: "high" | "medium" | "low";
    reason: string;
  }>;
  aiError: string | null;
}

// ═══════════════════════════════════════════════════════
// 필터 설정 — 여기를 수정하며 반복 실험
// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// 실험 설정 선택 — 여기만 바꿔서 반복 실험
// ═══════════════════════════════════════════════════════
const CONFIGS: Record<string, FilterConfig> = {
  // v1: 기존 설정 (baseline)
  v1_baseline: {
    removeAds: true,
    minTextLength: 100,
    parkingKeywords: [
      "주차", "parking", "주차장", "주차비", "주차요금", "주차면", "주차칸",
      "발렛", "기계식", "자주식", "무료주차", "유료주차", "주차타워",
    ],
    excludeKeywords: [],
    minNearbyLots: 1,
  },
  // v2: isAd 끄고 + 경매/분양 제거 키워드 추가
  v2_no_ad_filter: {
    removeAds: false,
    minTextLength: 100,
    parkingKeywords: [
      "주차", "parking", "주차장", "주차비", "주차요금", "주차면", "주차칸",
      "발렛", "기계식", "자주식", "무료주차", "유료주차", "주차타워",
    ],
    excludeKeywords: [
      "경매", "분양", "매매", "임대", "모델하우스", "입찰", "낙찰", "감정가",
      "체험단", "원룸", "투룸",
    ],
    minNearbyLots: 1,
  },
  // v3: isAd 유지 + 경매/분양 제거 키워드 추가
  v3_ad_plus_exclude: {
    removeAds: true,
    minTextLength: 100,
    parkingKeywords: [
      "주차", "parking", "주차장", "주차비", "주차요금", "주차면", "주차칸",
      "발렛", "기계식", "자주식", "무료주차", "유료주차", "주차타워",
    ],
    excludeKeywords: [
      "경매", "분양", "매매", "임대", "모델하우스", "입찰", "낙찰", "감정가",
      "체험단", "원룸", "투룸",
    ],
    minNearbyLots: 1,
  },
};

const ACTIVE_CONFIG = process.argv[2] || "all"; // "all" or config name

interface FilterConfig {
  removeAds: boolean;
  minTextLength: number;
  parkingKeywords: string[];
  excludeKeywords: string[];
  minNearbyLots: number;
}

// ─── 필터 함수 ──────────────────────────────────────────
function hasParkingKeyword(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

interface FilterVerdict {
  passed: boolean;
  removedBy: string | null;
  details: {
    isAd: boolean;
    textLength: number;
    hasParkingKw: boolean;
    nearbyLotCount: number;
  };
}

function hasExcludeKeyword(text: string, keywords: string[]): boolean {
  if (keywords.length === 0) return false;
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

function applyFilters(item: CollectedItem, config: FilterConfig): FilterVerdict {
  const text = item.fullText ?? "";
  const details = {
    isAd: item.isAd,
    textLength: item.fullTextLength,
    hasParkingKw: hasParkingKeyword(text, config.parkingKeywords),
    hasExcludeKw: hasExcludeKeyword(text, config.excludeKeywords),
    nearbyLotCount: item.nearbyLotCount,
  };

  if (config.removeAds && item.isAd) {
    return { passed: false, removedBy: "isAd", details };
  }
  if (item.fullTextLength < config.minTextLength) {
    return { passed: false, removedBy: "tooShort", details };
  }
  if (details.hasExcludeKw) {
    return { passed: false, removedBy: "excludeKeyword", details };
  }
  if (!details.hasParkingKw) {
    return { passed: false, removedBy: "noParkingKeyword", details };
  }
  if (item.nearbyLotCount < config.minNearbyLots) {
    return { passed: false, removedBy: "noNearbyLots", details };
  }

  return { passed: true, removedBy: null, details };
}

// ─── 단일 config 평가 ──────────────────────────────────
function evaluate(items: CollectedItem[], configName: string, config: FilterConfig, verbose: boolean) {
  console.log(`\n${"█".repeat(60)}`);
  console.log(`  CONFIG: ${configName}`);
  console.log(`${"█".repeat(60)}\n`);
  if (verbose) console.log("  설정:", JSON.stringify(config, null, 2), "\n");

  const verdicts = items.map((it) => ({
    item: it,
    verdict: applyFilters(it, config),
    hasAiMatch: it.aiMatches.length > 0,
    hasHighConfMatch: it.aiMatches.some((m) => m.confidence === "high"),
  }));

  // ═══════════════════════════════════════════════════════
  // 퍼널
  // ═══════════════════════════════════════════════════════
  const total = verdicts.length;
  const removedCounts: Record<string, number> = {};
  let survived = 0;
  for (const v of verdicts) {
    if (v.verdict.passed) {
      survived++;
    } else {
      removedCounts[v.verdict.removedBy!] = (removedCounts[v.verdict.removedBy!] ?? 0) + 1;
    }
  }

  console.log("═══ 필터 퍼널 ═══\n");
  console.log(`  전체: ${total}건`);
  for (const [reason, cnt] of Object.entries(removedCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${reason}: -${cnt}건`);
  }
  console.log(`  ─────────────────`);
  console.log(`  생존: ${survived}건 (${((survived / total) * 100).toFixed(1)}%)\n`);

  // ═══════════════════════════════════════════════════════
  // Confusion Matrix (필터 vs AI 답지)
  // ═══════════════════════════════════════════════════════
  // AI 에러나 fetch 실패 건은 제외
  const evaluable = verdicts.filter((v) => !v.item.aiError && v.item.fullText);

  let tp = 0; // 필터 통과 + AI 매칭 있음
  let fp = 0; // 필터 통과 + AI 매칭 없음 (불필요한 AI 호출)
  let fn = 0; // 필터 제거 + AI 매칭 있었음 (FALSE NEGATIVE)
  let tn = 0; // 필터 제거 + AI 매칭 없었음

  for (const v of evaluable) {
    if (v.verdict.passed && v.hasAiMatch) tp++;
    else if (v.verdict.passed && !v.hasAiMatch) fp++;
    else if (!v.verdict.passed && v.hasAiMatch) fn++;
    else tn++;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 0;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;

  console.log(`═══ Confusion Matrix (평가 가능: ${evaluable.length}건) ═══\n`);
  console.log(`                    AI 매칭 O    AI 매칭 X`);
  console.log(`  필터 통과         ${String(tp).padStart(4)}  (TP)   ${String(fp).padStart(4)}  (FP)`);
  console.log(`  필터 제거         ${String(fn).padStart(4)}  (FN)   ${String(tn).padStart(4)}  (TN)\n`);
  console.log(`  Precision: ${(precision * 100).toFixed(1)}% (필터 통과 중 실제 매칭 비율)`);
  console.log(`  Recall:    ${(recall * 100).toFixed(1)}% (AI 매칭 건 중 필터 통과 비율)`);
  console.log(`  F1:        ${(f1 * 100).toFixed(1)}%`);
  console.log(`  AI 호출 절감: ${total - survived}건 제거 → 비용 ~$${((total - survived) * 0.003).toFixed(1)} 절약\n`);

  // ═══════════════════════════════════════════════════════
  // 소스별 성능
  // ═══════════════════════════════════════════════════════
  console.log("═══ 소스별 성능 ═══\n");
  const sources = [...new Set(items.map((it) => it.source))];
  for (const src of sources) {
    const srcVerdicts = evaluable.filter((v) => v.item.source === src);
    if (srcVerdicts.length === 0) continue;

    const srcTp = srcVerdicts.filter((v) => v.verdict.passed && v.hasAiMatch).length;
    const srcFp = srcVerdicts.filter((v) => v.verdict.passed && !v.hasAiMatch).length;
    const srcFn = srcVerdicts.filter((v) => !v.verdict.passed && v.hasAiMatch).length;
    const srcTn = srcVerdicts.filter((v) => !v.verdict.passed && !v.hasAiMatch).length;
    const srcRecall = srcTp + srcFn > 0 ? srcTp / (srcTp + srcFn) : 0;
    const srcPrecision = srcTp + srcFp > 0 ? srcTp / (srcTp + srcFp) : 0;

    console.log(`  ${src} (${srcVerdicts.length}건): TP=${srcTp} FP=${srcFp} FN=${srcFn} TN=${srcTn} | P=${(srcPrecision * 100).toFixed(0)}% R=${(srcRecall * 100).toFixed(0)}%`);
  }
  console.log();

  // ═══════════════════════════════════════════════════════
  // FALSE NEGATIVE 상세 (가장 중요!)
  // ═══════════════════════════════════════════════════════
  const falseNegatives = evaluable.filter((v) => !v.verdict.passed && v.hasAiMatch);
  if (falseNegatives.length > 0) {
    console.log(`═══ ⚠️ FALSE NEGATIVES: ${falseNegatives.length}건 ═══\n`);
    for (const v of falseNegatives) {
      const aiLots = v.item.aiMatches.map((m) => `${m.lotName}(${m.confidence})`).join(", ");
      console.log(`  #${v.item.id} [${v.item.source}] ${v.item.title.slice(0, 60)}`);
      console.log(`    제거사유: ${v.verdict.removedBy} | 본문길이: ${v.verdict.details.textLength} | 주차KW: ${v.verdict.details.hasParkingKw} | 근접: ${v.verdict.details.nearbyLotCount}`);
      console.log(`    AI 매칭: ${aiLots}`);
      if (v.verdict.removedBy === "noParkingKeyword") {
        // 본문 앞부분 출력 (키워드가 정말 없는지 확인)
        console.log(`    본문 미리보기: "${(v.item.fullText ?? "").slice(0, 200).replace(/\n/g, " ")}"`);
      }
      console.log();
    }
  } else {
    console.log("═══ ✅ FALSE NEGATIVE 0건 — 필터 안전 ═══\n");
  }

  // ═══════════════════════════════════════════════════════
  // FALSE POSITIVE 샘플 (필터 통과했지만 AI 매칭 없음)
  // ═══════════════════════════════════════════════════════
  if (verbose) {
    const falsePositives = evaluable.filter((v) => v.verdict.passed && !v.hasAiMatch);
    if (falsePositives.length > 0) {
      console.log(`═══ FALSE POSITIVES: ${falsePositives.length}건 (불필요한 AI 호출) ═══\n`);
      for (const v of falsePositives.slice(0, 5)) {
        console.log(`  #${v.item.id} [${v.item.source}] ${v.item.title.slice(0, 60)}`);
        console.log(`    본문길이: ${v.verdict.details.textLength} | 근접: ${v.verdict.details.nearbyLotCount}`);
        console.log();
      }
    }
  }

  return { tp, fp, fn, tn, precision, recall, f1, survived, total: verdicts.length };
}

// ─── 메인 ───────────────────────────────────────────────
function main() {
  console.log("[Eval] 필터 v2 평가\n");

  const items: CollectedItem[] = JSON.parse(readFileSync(DATA_FILE, "utf-8"));
  console.log(`[Eval] 데이터 로드: ${items.length}건`);

  const sourceCounts: Record<string, number> = {};
  for (const it of items) sourceCounts[it.source] = (sourceCounts[it.source] ?? 0) + 1;
  console.log("[Eval] 소스 분포:", sourceCounts, "\n");

  const configsToRun = ACTIVE_CONFIG === "all"
    ? Object.entries(CONFIGS)
    : [[ACTIVE_CONFIG, CONFIGS[ACTIVE_CONFIG]]].filter(([, v]) => v) as [string, FilterConfig][];

  const summary: Array<{ name: string; tp: number; fp: number; fn: number; tn: number; p: string; r: string; f1: string; survived: string }> = [];

  for (const [name, config] of configsToRun) {
    const verbose = configsToRun.length === 1;
    const result = evaluate(items, name, config, verbose);
    summary.push({
      name,
      tp: result.tp, fp: result.fp, fn: result.fn, tn: result.tn,
      p: (result.precision * 100).toFixed(1) + "%",
      r: (result.recall * 100).toFixed(1) + "%",
      f1: (result.f1 * 100).toFixed(1) + "%",
      survived: `${result.survived}/${result.total}`,
    });
  }

  // 비교 테이블
  if (summary.length > 1) {
    console.log(`\n${"█".repeat(60)}`);
    console.log("  설정 비교 요약");
    console.log(`${"█".repeat(60)}\n`);
    console.log("  Config               TP   FP   FN   TN   Precision  Recall  F1      생존");
    console.log("  " + "─".repeat(85));
    for (const s of summary) {
      console.log(`  ${s.name.padEnd(20)} ${String(s.tp).padStart(4)} ${String(s.fp).padStart(4)} ${String(s.fn).padStart(4)} ${String(s.tn).padStart(4)}   ${s.p.padStart(6)}    ${s.r.padStart(6)}  ${s.f1.padStart(6)}  ${s.survived}`);
    }
    console.log();
  }
}

main();
