/**
 * 56K 코퍼스 기반 키워드 IDF(역문서빈도) 사전 계산
 *
 * 알고리즘 문서 §4.3 Step 3.
 * IDF(keyword) = log(전체 문서 수 / keyword 포함 문서 수)
 *
 * 결과: data/keyword-idf.json
 *
 * Usage:
 *   bun run scripts/compute-keyword-idf.ts [--remote]
 */
import { d1Query, isRemote } from "./lib/d1";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import {
  POSITIVE_KEYWORDS,
  NEGATIVE_KEYWORDS,
} from "../src/server/crawlers/lib/sentiment";

const ALL_KEYWORDS = [
  ...POSITIVE_KEYWORDS,
  ...NEGATIVE_KEYWORDS,
  // 추가 경험 키워드 (관련도 판별에도 쓰이지만 IDF도 필요)
  "주차", "주차면", "진입", "출차", "발렛", "주차타워",
  "차폭", "주차장 입구", "주차 공간", "주차하기",
];

// 중복 제거
const uniqueKeywords = [...new Set(ALL_KEYWORDS)];

async function main() {
  console.log(`[IDF] ${isRemote ? "REMOTE" : "LOCAL"} D1에서 코퍼스 로드 중...`);

  // 전체 문서 수
  const totalResult = d1Query<{ cnt: number }>(
    "SELECT COUNT(*) as cnt FROM web_sources",
  );
  const totalDocs = totalResult[0]?.cnt ?? 0;
  console.log(`[IDF] 전체 문서 수: ${totalDocs}`);

  if (totalDocs === 0) {
    console.error("[IDF] 문서가 없습니다.");
    process.exit(1);
  }

  // 키워드별 문서 빈도 계산
  const idfDict: Record<string, number> = {};

  for (const keyword of uniqueKeywords) {
    const escaped = keyword.replace(/'/g, "''");
    const result = d1Query<{ cnt: number }>(
      `SELECT COUNT(*) as cnt FROM web_sources WHERE LOWER(content) LIKE '%${escaped}%'`,
    );
    const docFreq = result[0]?.cnt ?? 0;

    if (docFreq === 0) {
      idfDict[keyword] = 1.0; // 코퍼스에 없으면 최대 IDF
    } else {
      // log(N / df), 0-1 범위로 정규화
      const rawIdf = Math.log(totalDocs / docFreq);
      const maxIdf = Math.log(totalDocs); // df=1일 때 최대
      idfDict[keyword] = Math.round((rawIdf / maxIdf) * 1000) / 1000;
    }

    console.log(
      `  ${keyword.padEnd(12)} → df=${docFreq.toString().padStart(5)}, IDF=${idfDict[keyword]}`,
    );
  }

  // 결과 저장
  const outDir = join(import.meta.dirname, "..", "data");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "keyword-idf.json");
  writeFileSync(outPath, JSON.stringify(idfDict, null, 2), "utf-8");

  console.log(`\n[IDF] 저장 완료: ${outPath}`);
  console.log(`[IDF] 키워드 ${Object.keys(idfDict).length}개`);
}

main().catch(console.error);
