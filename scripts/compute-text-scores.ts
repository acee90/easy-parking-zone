/**
 * web_sources 텍스트 감성 점수 배치 계산
 *
 * 알고리즘 문서 §6 Phase 1-3.
 * 모든 web_sources 행에 대해 관련도(relevance_score) + 감성(sentiment_score) 계산 후 DB 업데이트.
 *
 * Usage:
 *   bun run scripts/compute-text-scores.ts [--remote] [--dry-run]
 *
 * --dry-run: DB 업데이트 없이 결과를 JSON 파일로 저장
 */
import { d1Query, d1Execute, isRemote } from "./lib/d1";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  analyzeSentiment,
  computeRelevance,
  type IdfDict,
} from "../src/server/crawlers/lib/sentiment";

const isDryRun = process.argv.includes("--dry-run");
const BATCH_SIZE = 500;

interface WebSource {
  id: number;
  content: string;
  title: string;
  published_at: string | null;
  source: string;
  parking_lot_id: string;
}

async function main() {
  console.log(
    `[Sentiment] ${isRemote ? "REMOTE" : "LOCAL"} D1 | ${isDryRun ? "DRY-RUN" : "LIVE"}`,
  );

  // IDF 사전 로드
  const idfPath = join(import.meta.dirname, "..", "data", "keyword-idf.json");
  let idfDict: IdfDict | null = null;
  if (existsSync(idfPath)) {
    idfDict = JSON.parse(readFileSync(idfPath, "utf-8"));
    console.log(
      `[Sentiment] IDF 사전 로드: ${Object.keys(idfDict!).length}개 키워드`,
    );
  } else {
    console.warn(
      "[Sentiment] IDF 사전 없음 (data/keyword-idf.json). 기본 가중치 사용.",
    );
  }

  // 전체 행 수 확인
  const countResult = d1Query<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM web_sources",
  );
  const totalRows = countResult[0]?.cnt ?? 0;
  console.log(`[Sentiment] 처리 대상: ${totalRows}건`);

  let processed = 0;
  let updated = 0;
  let skipped = 0;
  const results: Array<{
    id: number;
    parkingLotId: string;
    relevance: number;
    sentimentRaw: number;
    sentimentScore: number;
    matchCount: number;
  }> = [];

  // 배치 처리
  let offset = 0;
  while (offset < totalRows) {
    const rows = d1Query<WebSource>(
      `SELECT id, content, title, published_at, source, parking_lot_id FROM web_sources ORDER BY id LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );

    if (rows.length === 0) break;

    const updates: string[] = [];

    for (const row of rows) {
      // title + content 합쳐서 분석 (블로그는 제목에도 정보 있음)
      const fullText = `${row.title} ${row.content}`;
      const result = analyzeSentiment(fullText, idfDict);

      // relevance_score: 0-100 정수 (기존 스키마 호환)
      const relevanceInt = Math.round(result.relevance * 100);
      // is_positive: 0/1 (기존 스키마 호환)
      const isPositive = result.sentimentRaw > 0 ? 1 : result.sentimentRaw < 0 ? 0 : null;

      results.push({
        id: row.id,
        parkingLotId: row.parking_lot_id,
        relevance: result.relevance,
        sentimentRaw: result.sentimentRaw,
        sentimentScore: result.sentimentScore,
        matchCount: result.matchCount,
      });

      if (!isDryRun) {
        // sentiment_score (REAL), relevance_score (INTEGER), is_positive (INTEGER) 업데이트
        const sentimentVal = result.matchCount > 0 ? result.sentimentScore : "NULL";
        const isPositiveVal = isPositive !== null ? isPositive : "NULL";
        updates.push(
          `UPDATE web_sources SET relevance_score = ${relevanceInt}, is_positive = ${isPositiveVal}, sentiment_score = ${sentimentVal} WHERE id = ${row.id}`,
        );
      }

      processed++;
    }

    // 배치 DB 업데이트
    if (!isDryRun && updates.length > 0) {
      for (const sql of updates) {
        try {
          d1Execute(sql);
          updated++;
        } catch (e) {
          console.error(`[Sentiment] 업데이트 실패 (id): ${e}`);
          skipped++;
        }
      }
    }

    offset += BATCH_SIZE;
    console.log(`[Sentiment] 진행: ${processed}/${totalRows}`);
  }

  // 통계
  const relevantCount = results.filter((r) => r.relevance > 0.3).length;
  const highRelevanceCount = results.filter((r) => r.relevance >= 0.7).length;
  const avgSentiment =
    results
      .filter((r) => r.matchCount > 0)
      .reduce((sum, r) => sum + r.sentimentScore, 0) /
    (results.filter((r) => r.matchCount > 0).length || 1);

  console.log("\n[Sentiment] === 결과 요약 ===");
  console.log(`  전체: ${processed}건`);
  console.log(`  관련도 > 0.3: ${relevantCount}건 (${((relevantCount / processed) * 100).toFixed(1)}%)`);
  console.log(`  관련도 ≥ 0.7: ${highRelevanceCount}건 (${((highRelevanceCount / processed) * 100).toFixed(1)}%)`);
  console.log(`  감성 키워드 매칭: ${results.filter((r) => r.matchCount > 0).length}건`);
  console.log(`  평균 감성 점수: ${avgSentiment.toFixed(2)} (1-5 스케일)`);
  if (!isDryRun) {
    console.log(`  DB 업데이트: ${updated}건, 실패: ${skipped}건`);
  }

  // dry-run이면 결과 JSON 저장
  if (isDryRun) {
    const outPath = join(
      import.meta.dirname,
      "text-sentiment-results.json",
    );
    writeFileSync(outPath, JSON.stringify(results, null, 2), "utf-8");
    console.log(`\n[Sentiment] 결과 저장: ${outPath}`);
  }
}

main().catch(console.error);
