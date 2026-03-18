/**
 * 블로그/카페 후기 크롤링 (멀티 검색 엔진)
 *
 * - parking_lots 테이블의 주차장별로 블로그/카페 검색
 * - 관련도 점수(relevance_score) 기반 필터링
 * - 제네릭 이름 감지로 무의미한 API 호출 절감
 * - 엔진별 진행상황 저장 → 중단 후 재개 가능
 *
 * 사용법:
 *   bun scripts/crawl-blogs.ts                          # 기본: naver
 *   bun scripts/crawl-blogs.ts --engine=kakao           # 카카오(다음) 블로그
 *   bun scripts/crawl-blogs.ts --engine=naver           # 네이버 블로그+카페
 *   bun scripts/crawl-blogs.ts --uncovered-only         # 데이터 없는 주차장만
 *   bun scripts/crawl-blogs.ts --uncovered-only --remote
 */
import { existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { d1Query, isRemote } from "./lib/d1";
import { stripHtml, parsePostdate, hashUrl } from "./lib/naver-api";
import { extractRegion, isGenericName, sleep } from "./lib/geo";
import { loadProgress, saveProgress } from "./lib/progress";
import { buildInsert, flushStatements } from "./lib/sql-flush";
import {
  getEngine,
  type SearchItem,
  type SourceType,
} from "./lib/search-engine";

// --- Config ---
const DELAY = 300;
const RELEVANCE_THRESHOLD = 40;
const RESULTS_PER_QUERY = 5;
const DB_FLUSH_SIZE = 50;

// --- CLI ---
const engineName = (() => {
  const flag = process.argv.find((a) => a.startsWith("--engine="));
  return flag ? flag.split("=")[1] : "naver";
})();
const UNCOVERED_ONLY = process.argv.includes("--uncovered-only");

const progressSuffix = UNCOVERED_ONLY ? `${engineName}-uncovered` : engineName;
const PROGRESS_JSON = resolve(import.meta.dir, `${progressSuffix}-progress.json`);
const TMP_SQL = resolve(import.meta.dir, `../.tmp-${progressSuffix}.sql`);

// --- Types ---
interface ParkingRow {
  id: string;
  name: string;
  address: string;
}

interface Progress {
  engine: string;
  completedIds: string[];
  totalApiCalls: number;
  savedReviews: number;
  skippedGeneric: number;
  skippedLowRelevance: number;
  startedAt: string;
  lastUpdatedAt: string;
}

interface PendingReview {
  parkingLotId: string;
  source: SourceType;
  sourceId: string;
  title: string;
  content: string;
  sourceUrl: string;
  author: string;
  publishedAt: string | null;
  relevanceScore: number;
}

const REVIEW_COLUMNS = [
  "parking_lot_id", "source", "source_id", "title", "content",
  "source_url", "author", "published_at", "relevance_score",
];

/** 검색 결과 관련도 점수 (0-100) */
function scoreRelevance(
  item: SearchItem,
  name: string,
  address: string
): number {
  let score = 0;
  const title = stripHtml(item.title).toLowerCase();
  const desc = stripHtml(item.description).toLowerCase();
  const nameLower = name.toLowerCase();

  // 이름에서 일반 접미사 제거 후 의미 있는 키워드 추출
  const nameKeywords = nameLower
    .replace(/주차장|공영|노외|노상|부설|제\d+/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  // 너무 흔한 단어는 단독 매칭에서 제외 (다른 키워드와 함께일 때만 유효)
  const COMMON_WORDS = new Set(["시장", "공원", "아파트", "역사", "학교", "병원", "마을", "센터", "회관"]);
  const specificKeywords = nameKeywords.filter((kw) => !COMMON_WORDS.has(kw));
  const hasSpecificMatch = specificKeywords.length > 0;

  // 키워드 매칭 점수: 여러 키워드가 맞을수록 높은 점수
  const titleMatches = nameKeywords.filter((kw) => title.includes(kw));
  const descMatches = nameKeywords.filter((kw) => desc.includes(kw));
  const titleSpecificMatches = specificKeywords.filter((kw) => title.includes(kw));

  if (titleMatches.length >= 2) score += 50;       // 키워드 2개 이상 제목 매칭 → 강한 신호
  else if (titleSpecificMatches.length >= 1) score += 40;  // 고유 키워드 1개 제목 매칭
  else if (titleMatches.length === 1) score += 25;  // 흔한 키워드 1개만 → 약한 신호

  if (descMatches.length >= 2) score += 20;
  else if (descMatches.some((kw) => !COMMON_WORDS.has(kw))) score += 15;
  else if (descMatches.length === 1) score += 5;

  // 지역 매칭
  const region = extractRegion(address).toLowerCase();
  const regionWords = region.split(/\s+/).filter((w) => w.length >= 2);
  if (regionWords.some((rw) => title.includes(rw) || desc.includes(rw))) score += 20;

  // 주차 키워드
  if (title.includes("주차") || desc.includes("주차")) score += 10;

  // 이름 키워드가 제목/본문 어디에도 없으면 오매칭 → 30점 상한
  if (titleMatches.length === 0 && descMatches.length === 0) score = Math.min(score, 30);

  // 고유 키워드 없이 흔한 단어만 매칭된 경우 → 45점 상한
  if (hasSpecificMatch && titleSpecificMatches.length === 0 &&
      !specificKeywords.some((kw) => desc.includes(kw))) {
    score = Math.min(score, 45);
  }

  return score;
}

// --- DB helpers ---
function flushToDB(reviews: PendingReview[], progress: Progress) {
  if (reviews.length === 0) return;

  const stmts = reviews.map((r) =>
    buildInsert("web_sources", REVIEW_COLUMNS, [
      r.parkingLotId, r.source, r.sourceId, r.title, r.content,
      r.sourceUrl, r.author, r.publishedAt, r.relevanceScore,
    ])
  );

  flushStatements(TMP_SQL, stmts);
  progress.savedReviews += reviews.length;
}

// --- Main ---
async function main() {
  const engine = getEngine(engineName);
  engine.validateEnv();

  console.log(`🔍 검색 엔진: ${engine.name} (${engine.channels.map((c) => c.name).join(", ")})`);

  const progress = loadProgress<Progress>(PROGRESS_JSON, {
    engine: engineName,
    completedIds: [],
    totalApiCalls: 0,
    savedReviews: 0,
    skippedGeneric: 0,
    skippedLowRelevance: 0,
    startedAt: "",
    lastUpdatedAt: "",
  });
  const completedSet = new Set(progress.completedIds);

  if (isRemote) console.log("🌐 리모트 D1 모드");
  if (UNCOVERED_ONLY) console.log("🎯 미커버 주차장만 대상");
  console.log();

  console.log("주차장 목록 조회 중...");
  let lots: ParkingRow[];
  if (UNCOVERED_ONLY) {
    lots = d1Query(
      "SELECT id, name, address FROM parking_lots WHERE id NOT IN (SELECT DISTINCT parking_lot_id FROM web_sources)"
    );
  } else {
    lots = d1Query("SELECT id, name, address FROM parking_lots");
  }
  console.log(`대상 ${lots.length}개 주차장, ${completedSet.size}개 완료됨\n`);

  let pending: PendingReview[] = [];
  let processed = 0;

  for (const lot of lots) {
    if (completedSet.has(lot.id)) continue;

    if (isGenericName(lot.name)) {
      progress.skippedGeneric++;
      completedSet.add(lot.id);
      progress.completedIds.push(lot.id);
      processed++;
      continue;
    }

    const region = extractRegion(lot.address);
    const query = `${lot.name} 주차장 ${region}`.trim();

    // 각 채널(블로그, 카페 등) 순차 검색
    for (const channel of engine.channels) {
      try {
        const result = await channel.search(query, RESULTS_PER_QUERY);
        progress.totalApiCalls++;

        for (const item of result.items) {
          const score = scoreRelevance(item, lot.name, lot.address);
          if (score < RELEVANCE_THRESHOLD) {
            progress.skippedLowRelevance++;
            continue;
          }
          const sourceId = await hashUrl(item.link);
          pending.push({
            parkingLotId: lot.id,
            source: channel.sourceType,
            sourceId,
            title: stripHtml(item.title),
            content: stripHtml(item.description),
            sourceUrl: item.link,
            author: item.author,
            publishedAt: parsePostdate(item.postdate),
            relevanceScore: score,
          });
        }
      } catch (err) {
        console.error(`\n  ${channel.name} 검색 실패 (${lot.name}):`, (err as Error).message);
      }

      await sleep(DELAY);
    }

    completedSet.add(lot.id);
    progress.completedIds.push(lot.id);
    processed++;

    if (pending.length >= DB_FLUSH_SIZE) {
      flushToDB(pending, progress);
      pending = [];
    }

    if (processed % 20 === 0) {
      saveProgress(PROGRESS_JSON, progress);
      process.stdout.write(
        `\r  ${completedSet.size}/${lots.length} | 저장 ${progress.savedReviews}건 | API ${progress.totalApiCalls}회 | 제네릭스킵 ${progress.skippedGeneric} | 저관련도스킵 ${progress.skippedLowRelevance}`
      );
    }
  }

  if (pending.length > 0) {
    flushToDB(pending, progress);
  }

  saveProgress(PROGRESS_JSON, progress);
  if (existsSync(TMP_SQL)) unlinkSync(TMP_SQL);

  console.log(
    `\n\n✅ 완료! [${engine.name}] ${progress.savedReviews}건 저장 | API ${progress.totalApiCalls}회 | 제네릭스킵 ${progress.skippedGeneric} | 저관련도스킵 ${progress.skippedLowRelevance}`
  );
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
