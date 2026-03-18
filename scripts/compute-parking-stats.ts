/**
 * 주차장 통합 난이도 점수 배치 계산
 *
 * 알고리즘 문서 §4.1~4.5 구현.
 * parking_lot_stats 테이블에 베이지안 통합 점수를 사전 계산하여 저장.
 *
 * Usage:
 *   bun run scripts/compute-parking-stats.ts [--remote] [--dry-run]
 */
import { d1Query, d1Execute, isRemote } from "./lib/d1";
import { writeFileSync } from "fs";
import { join } from "path";
import { timeDecay } from "../src/server/crawlers/lib/sentiment";

const isDryRun = process.argv.includes("--dry-run");
const BATCH_SIZE = 1000;

/** 베이지안 신뢰 임계치 — 유효 5건 이상이면 실제 데이터가 지배 */
const C = 5;

/** 소스별 기본 가중치 */
const WEIGHTS = {
  user: 0.50,
  community: 0.30,
  blog: 0.15,
  youtube: 0.15,
} as const;

// ---------------------------------------------------------------------------
// 1. 구조적 사전 점수 (Structural Prior) — §4.1
// ---------------------------------------------------------------------------

interface ParkingLot {
  id: string;
  name: string;
  type: string | null;
  total_spaces: number | null;
  is_free: number | null;
  notes: string | null;
  curation_tag: string | null;
}

function computeStructuralPrior(lot: ParkingLot): number {
  // 큐레이션 태그가 있으면 앵커 값 직접 사용
  if (lot.curation_tag === "hell") return 1.3;  // 헬 임계값(1.5) 아래
  if (lot.curation_tag === "easy") return 4.0;

  // 리뷰 없는 주차장은 "보통"(2.7-3.2) 범위에 모이도록 조정폭 축소
  let score = 3.0; // 중립 기본값 (보통 중앙)

  const nameNotes = `${lot.name} ${lot.notes ?? ""}`.toLowerCase();

  // 기계식 주차장 감지 — 보통 하단(별로 경계)
  if (nameNotes.includes("기계식") || nameNotes.includes("기계")) {
    score -= 0.15;
  }

  // 총 면수
  if (lot.total_spaces !== null) {
    if (lot.total_spaces < 30) score -= 0.05;
    if (lot.total_spaces > 200) score += 0.1;
  }

  // 지하 주차장 감지
  if (nameNotes.includes("지하")) {
    score -= 0.05;
  }

  // 노외 주차장 (넓은 편)
  if (lot.type === "노외") {
    score += 0.08;
  }

  // 무료 주차장 (접근성)
  if (lot.is_free === 1) {
    score += 0.04;
  }

  return Math.max(1.0, Math.min(5.0, score));
}

// ---------------------------------------------------------------------------
// 2. 소스별 점수 집계 — §4.2~4.3
// ---------------------------------------------------------------------------

interface ReviewRow {
  parking_lot_id: string;
  overall_score: number;
  is_seed: number;
  source_type: string | null;
  created_at: string;
}

interface TextRow {
  parking_lot_id: string;
  sentiment_score: number;
  relevance_score: number;
  source: string;
  published_at: string | null;
  match_type: "direct" | "ai_high" | "ai_medium";
}

interface SourceScores {
  userReviewScore: number | null;
  userReviewCount: number;
  communityScore: number | null;
  communityCount: number;
  textScore: number | null;
  textCount: number;
  nEffective: number;
}

function computeSourceScores(
  reviews: ReviewRow[],
  texts: TextRow[],
  now: Date,
): SourceScores {
  // 사용자 리뷰 (source_type IS NULL, is_seed=0)
  const userReviews = reviews.filter(
    (r) => r.source_type === null && r.is_seed === 0,
  );
  // 커뮤니티 리뷰 (source_type IS NOT NULL) + seed 리뷰
  const communityReviews = reviews.filter(
    (r) => r.source_type !== null || r.is_seed === 1,
  );

  // 시간 감쇠 가중 평균
  function weightedAvg(
    items: { score: number; date: string; weight: number }[],
  ): number | null {
    if (items.length === 0) return null;
    let wSum = 0;
    let wTotal = 0;
    for (const item of items) {
      const d = timeDecay(item.date, now);
      wSum += item.weight * d * item.score;
      wTotal += item.weight * d;
    }
    return wTotal > 0 ? wSum / wTotal : null;
  }

  const userReviewScore = weightedAvg(
    userReviews.map((r) => ({
      score: r.overall_score,
      date: r.created_at,
      weight: 1.0,
    })),
  );

  const communityScore = weightedAvg(
    communityReviews.map((r) => ({
      score: r.overall_score,
      date: r.created_at,
      weight: r.is_seed === 1 ? 0.3 : 0.6,
    })),
  );

  // 텍스트 감성 (관련도 > 30, sentiment_score NOT NULL)
  // match_type별 가중치 감쇠: direct=1.0, ai_high=0.8, ai_medium=0.5
  const MATCH_TYPE_FACTOR = { direct: 1.0, ai_high: 0.8, ai_medium: 0.5 } as const;
  const relevantTexts = texts.filter(
    (t) => t.relevance_score > 30 && t.sentiment_score !== null,
  );
  const textScore = weightedAvg(
    relevantTexts.map((t) => ({
      score: t.sentiment_score,
      date: t.published_at ?? "",
      weight: (t.relevance_score / 100) * MATCH_TYPE_FACTOR[t.match_type],
    })),
  );

  // 유효 데이터량
  const highRelevanceTexts = texts.filter((t) => t.relevance_score >= 70);
  const nEffective =
    userReviews.length * 1.0 +
    communityReviews.length * 0.6 +
    highRelevanceTexts.reduce((sum, t) => sum + 0.2 * MATCH_TYPE_FACTOR[t.match_type], 0);

  return {
    userReviewScore: userReviewScore
      ? Math.round(userReviewScore * 100) / 100
      : null,
    userReviewCount: userReviews.length,
    communityScore: communityScore
      ? Math.round(communityScore * 100) / 100
      : null,
    communityCount: communityReviews.length,
    textScore: textScore ? Math.round(textScore * 100) / 100 : null,
    textCount: relevantTexts.length,
    nEffective: Math.round(nEffective * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// 3. 베이지안 통합 — §4.4
// ---------------------------------------------------------------------------

interface StatsRow {
  parkingLotId: string;
  structuralPrior: number;
  userReviewScore: number | null;
  userReviewCount: number;
  communityScore: number | null;
  communityCount: number;
  textScore: number | null;
  textCount: number;
  nEffective: number;
  finalScore: number;
  reliability: string;
}

function computeFinalScore(
  prior: number,
  sources: SourceScores,
): { finalScore: number; reliability: string } {
  // 활성 소스 수집 + 가중치 재분배
  const active: { key: string; weight: number; score: number }[] = [];

  if (sources.userReviewScore !== null) {
    active.push({ key: "user", weight: WEIGHTS.user, score: sources.userReviewScore });
  }
  if (sources.communityScore !== null) {
    active.push({ key: "community", weight: WEIGHTS.community, score: sources.communityScore });
  }
  if (sources.textScore !== null) {
    // blog + youtube 텍스트를 하나로 합산
    active.push({ key: "text", weight: WEIGHTS.blog + WEIGHTS.youtube, score: sources.textScore });
  }

  // 데이터가 전혀 없으면 구조 속성만 사용
  if (active.length === 0) {
    return {
      finalScore: Math.round(prior * 100) / 100,
      reliability: prior !== 3.0 ? "structural" : "none",
    };
  }

  // 가중치 재분배 (합 = 1.0)
  const totalWeight = active.reduce((s, a) => s + a.weight, 0);
  const rawScore =
    active.reduce((s, a) => s + (a.weight / totalWeight) * a.score, 0);

  // 베이지안 평균: (C × m + n_eff × raw) / (C + n_eff)
  const finalScore =
    (C * prior + sources.nEffective * rawScore) / (C + sources.nEffective);
  const clamped = Math.max(1.0, Math.min(5.0, Math.round(finalScore * 100) / 100));

  // 신뢰도 등급
  let reliability: string;
  if (sources.nEffective >= 5) {
    reliability = "confirmed";
  } else if (sources.nEffective >= 1) {
    reliability = "estimated";
  } else if (sources.nEffective > 0) {
    reliability = "reference";
  } else {
    reliability = "structural";
  }

  return { finalScore: clamped, reliability };
}

// ---------------------------------------------------------------------------
// 4. 메인 배치 처리
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `[Stats] ${isRemote ? "REMOTE" : "LOCAL"} D1 | ${isDryRun ? "DRY-RUN" : "LIVE"}`,
  );

  const now = new Date();

  // 전체 주차장 수
  const totalResult = d1Query<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM parking_lots",
  );
  const totalLots = totalResult[0]?.cnt ?? 0;
  console.log(`[Stats] 전체 주차장: ${totalLots}개`);

  // 전체 리뷰 로드 (parking_lot_id별 그룹핑용)
  console.log("[Stats] 리뷰 로드 중...");
  const allReviews = d1Query<ReviewRow>(
    "SELECT parking_lot_id, overall_score, is_seed, source_type, created_at FROM user_reviews",
  );
  const reviewsByLot = new Map<string, ReviewRow[]>();
  for (const r of allReviews) {
    if (!reviewsByLot.has(r.parking_lot_id))
      reviewsByLot.set(r.parking_lot_id, []);
    reviewsByLot.get(r.parking_lot_id)!.push(r);
  }
  console.log(
    `[Stats] 리뷰 ${allReviews.length}건 (${reviewsByLot.size}개 주차장)`,
  );

  // 전체 텍스트 감성 로드 (직접 매칭 + ai_matches UNION)
  console.log("[Stats] 텍스트 감성 로드 중...");
  const allTexts = d1Query<TextRow>(
    `SELECT ws.parking_lot_id, ws.sentiment_score, ws.relevance_score, ws.source, ws.published_at, 'direct' as match_type
     FROM web_sources ws
     WHERE ws.is_ad = 0 AND ws.parking_lot_id IS NOT NULL
       AND (ws.sentiment_score IS NOT NULL OR ws.relevance_score > 30)
     UNION ALL
     SELECT am.parking_lot_id, ws.sentiment_score, ws.relevance_score, ws.source, ws.published_at,
       CASE am.confidence WHEN 'high' THEN 'ai_high' ELSE 'ai_medium' END as match_type
     FROM web_source_ai_matches am
     JOIN web_sources ws ON ws.id = am.web_source_id
     WHERE ws.is_ad = 0
       AND (ws.sentiment_score IS NOT NULL OR ws.relevance_score > 30)
       AND am.confidence IN ('high', 'medium')
       AND (ws.parking_lot_id IS NULL OR am.parking_lot_id != ws.parking_lot_id)`,
  );
  const textsByLot = new Map<string, TextRow[]>();
  for (const t of allTexts) {
    if (!textsByLot.has(t.parking_lot_id))
      textsByLot.set(t.parking_lot_id, []);
    textsByLot.get(t.parking_lot_id)!.push(t);
  }
  const directTexts = allTexts.filter((t) => t.match_type === "direct").length;
  const aiTexts = allTexts.length - directTexts;
  console.log(
    `[Stats] 텍스트 ${allTexts.length}건 (직접 ${directTexts} + AI매칭 ${aiTexts}) → ${textsByLot.size}개 주차장`,
  );

  // 배치 처리
  const results: StatsRow[] = [];
  let offset = 0;

  while (offset < totalLots) {
    const lots = d1Query<ParkingLot>(
      `SELECT id, name, type, total_spaces, is_free, notes, curation_tag FROM parking_lots ORDER BY id LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );

    if (lots.length === 0) break;

    for (const lot of lots) {
      const prior = computeStructuralPrior(lot);
      const reviews = reviewsByLot.get(lot.id) ?? [];
      const texts = textsByLot.get(lot.id) ?? [];
      const sources = computeSourceScores(reviews, texts, now);
      const { finalScore, reliability } = computeFinalScore(prior, sources);

      results.push({
        parkingLotId: lot.id,
        structuralPrior: prior,
        userReviewScore: sources.userReviewScore,
        userReviewCount: sources.userReviewCount,
        communityScore: sources.communityScore,
        communityCount: sources.communityCount,
        textScore: sources.textScore,
        textCount: sources.textCount,
        nEffective: sources.nEffective,
        finalScore,
        reliability,
      });
    }

    offset += lots.length;
    console.log(`[Stats] 진행: ${offset}/${totalLots}`);
  }

  // 통계 요약
  const reliabilityCounts: Record<string, number> = {};
  const scoreBuckets = {
    "4.0-5.0 😊 초보추천": 0,
    "3.3-3.9 🙂 무난": 0,
    "2.7-3.2 😐 보통": 0,
    "2.0-2.6 😕 별로": 0,
    "1.5-1.9 💀 비추": 0,
    "1.0-1.4 🔥 헬": 0,
  };
  for (const r of results) {
    reliabilityCounts[r.reliability] =
      (reliabilityCounts[r.reliability] ?? 0) + 1;
    const s = r.finalScore;
    if (s >= 4.0) scoreBuckets["4.0-5.0 😊 초보추천"]++;
    else if (s >= 3.3) scoreBuckets["3.3-3.9 🙂 무난"]++;
    else if (s >= 2.7) scoreBuckets["2.7-3.2 😐 보통"]++;
    else if (s >= 2.0) scoreBuckets["2.0-2.6 😕 별로"]++;
    else if (s >= 1.5) scoreBuckets["1.5-1.9 💀 비추"]++;
    else scoreBuckets["1.0-1.4 🔥 헬"]++;
  }

  console.log("\n[Stats] === 결과 요약 ===");
  console.log("  신뢰도 등급 분포:");
  for (const [k, v] of Object.entries(reliabilityCounts).sort()) {
    console.log(`    ${k.padEnd(15)} ${v.toString().padStart(6)}`);
  }
  console.log("  점수 분포:");
  for (const [k, v] of Object.entries(scoreBuckets)) {
    console.log(`    ${k.padEnd(15)} ${v.toString().padStart(6)} (${((v / results.length) * 100).toFixed(1)}%)`);
  }

  // DB 업데이트
  if (!isDryRun) {
    console.log("\n[Stats] DB 업데이트 중...");
    // SQL 파일로 배치 생성
    const CHUNK = 2000;
    for (let i = 0; i < results.length; i += CHUNK) {
      const chunk = results.slice(i, i + CHUNK);
      const sql = chunk
        .map((r) => {
          const vals = [
            `'${r.parkingLotId}'`,
            r.structuralPrior,
            r.userReviewScore ?? "NULL",
            r.userReviewCount,
            r.communityScore ?? "NULL",
            r.communityCount,
            r.textScore ?? "NULL",
            r.textCount,
            r.nEffective,
            r.finalScore,
            `'${r.reliability}'`,
            "datetime('now')",
          ].join(",");
          return `INSERT OR REPLACE INTO parking_lot_stats (parking_lot_id,structural_prior,user_review_score,user_review_count,community_score,community_count,text_sentiment_score,text_source_count,n_effective,final_score,reliability,computed_at) VALUES (${vals});`;
        })
        .join("\n");

      const tmpFile = join(import.meta.dirname, `_stats_batch_${i}.sql`);
      const { writeFileSync: wf, unlinkSync } = await import("fs");
      wf(tmpFile, sql, "utf-8");

      try {
        const { execSync } = await import("child_process");
        const target = isRemote ? "--remote" : "--local";
        execSync(
          `npx wrangler d1 execute parking-db ${target} --file="${tmpFile}"`,
          { stdio: "pipe" },
        );
        console.log(`  배치 ${i / CHUNK + 1}: ${chunk.length}건 완료`);
      } finally {
        const { unlinkSync: ul } = await import("fs");
        ul(tmpFile);
      }
    }
    console.log("[Stats] DB 업데이트 완료");
  } else {
    const outPath = join(import.meta.dirname, "parking-stats-results.json");
    writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`\n[Stats] 결과 저장: ${outPath}`);
  }

  // 큐레이션 일관성 검증
  const hellLots = results.filter(
    (r) =>
      r.structuralPrior === 1.5 &&
      r.reliability !== "none" &&
      r.reliability !== "structural",
  );
  const easyLots = results.filter(
    (r) =>
      r.structuralPrior === 4.0 &&
      r.reliability !== "none" &&
      r.reliability !== "structural",
  );

  if (hellLots.length > 0) {
    const hellBelow25 = hellLots.filter((l) => l.finalScore < 2.5).length;
    console.log(
      `\n[검증] Hell 큐레이션(데이터 있음): ${hellLots.length}개 → 2.5 미만: ${hellBelow25}개 (${((hellBelow25 / hellLots.length) * 100).toFixed(0)}%)`,
    );
  }
  if (easyLots.length > 0) {
    const easyAbove35 = easyLots.filter((l) => l.finalScore > 3.5).length;
    console.log(
      `[검증] Easy 큐레이션(데이터 있음): ${easyLots.length}개 → 3.5 이상: ${easyAbove35}개 (${((easyAbove35 / easyLots.length) * 100).toFixed(0)}%)`,
    );
  }

  // 커버리지 비교
  const withData = results.filter(
    (r) => r.reliability !== "none",
  ).length;
  const prevCoverage = reviewsByLot.size; // 기존: 리뷰 있는 주차장만
  console.log(
    `\n[커버리지] 기존(리뷰만): ${prevCoverage}개 → 새(통합): ${withData}개 (+${withData - prevCoverage}개)`,
  );
}

main().catch(console.error);
