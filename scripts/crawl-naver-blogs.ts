/**
 * 네이버 블로그/카페 후기 크롤링
 *
 * - parking_lots 테이블의 주차장별로 네이버 블로그/카페 검색
 * - 관련도 점수(relevance_score) 기반 필터링
 * - 제네릭 이름 감지로 무의미한 API 호출 절감
 * - 진행상황을 scripts/naver-progress.json에 저장 → 중단 후 재개 가능
 *
 * 사용법: bun run crawl-naver
 */
import { existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { d1Query, isRemote } from "./lib/d1";
import {
  searchNaverBlog,
  searchNaverCafe,
  stripHtml,
  parsePostdate,
  hashUrl,
  type NaverSearchItem,
} from "./lib/naver-api";
import { extractRegion, isGenericName, sleep } from "./lib/geo";
import { loadProgress, saveProgress } from "./lib/progress";
import { esc, buildInsert, flushStatements } from "./lib/sql-flush";

// --- Config ---
const DELAY = 300;
const RELEVANCE_THRESHOLD = 40;
const RESULTS_PER_QUERY = 5;
const DB_FLUSH_SIZE = 50;

const PROGRESS_JSON = resolve(import.meta.dir, "naver-progress.json");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-naver.sql");

// --- Types ---
interface ParkingRow {
  id: string;
  name: string;
  address: string;
}

interface Progress {
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
  source: "naver_blog" | "naver_cafe";
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
  item: NaverSearchItem,
  name: string,
  address: string
): number {
  let score = 0;
  const title = stripHtml(item.title).toLowerCase();
  const desc = stripHtml(item.description).toLowerCase();
  const nameLower = name.toLowerCase();

  const nameKeywords = nameLower
    .replace(/주차장|공영|노외|노상|부설/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (nameKeywords.some((kw) => title.includes(kw))) score += 40;
  if (nameKeywords.some((kw) => desc.includes(kw))) score += 20;

  const region = extractRegion(address).toLowerCase();
  const regionWords = region.split(/\s+/).filter((w) => w.length >= 2);
  if (regionWords.some((rw) => title.includes(rw) || desc.includes(rw))) score += 20;

  if (title.includes("주차") || desc.includes("주차")) score += 20;

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
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
    console.error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET가 .env에 설정되지 않았습니다.");
    process.exit(1);
  }

  const progress = loadProgress<Progress>(PROGRESS_JSON, {
    completedIds: [],
    totalApiCalls: 0,
    savedReviews: 0,
    skippedGeneric: 0,
    skippedLowRelevance: 0,
    startedAt: "",
    lastUpdatedAt: "",
  });
  const completedSet = new Set(progress.completedIds);

  if (isRemote) console.log("🌐 리모트 D1 모드\n");
  console.log("주차장 목록 조회 중...");
  const lots: ParkingRow[] = d1Query("SELECT id, name, address FROM parking_lots");
  console.log(`총 ${lots.length}개 주차장, ${completedSet.size}개 완료됨`);

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

    // 블로그 검색
    try {
      const blogRes = await searchNaverBlog(query, RESULTS_PER_QUERY);
      progress.totalApiCalls++;

      for (const item of blogRes.items) {
        const score = scoreRelevance(item, lot.name, lot.address);
        if (score < RELEVANCE_THRESHOLD) {
          progress.skippedLowRelevance++;
          continue;
        }
        const sourceId = await hashUrl(item.link);
        pending.push({
          parkingLotId: lot.id,
          source: "naver_blog",
          sourceId,
          title: stripHtml(item.title),
          content: stripHtml(item.description),
          sourceUrl: item.link,
          author: item.bloggername ?? "",
          publishedAt: parsePostdate(item.postdate),
          relevanceScore: score,
        });
      }
    } catch (err) {
      console.error(`\n  블로그 검색 실패 (${lot.name}):`, (err as Error).message);
    }

    await sleep(DELAY);

    // 카페 검색
    try {
      const cafeRes = await searchNaverCafe(query, RESULTS_PER_QUERY);
      progress.totalApiCalls++;

      for (const item of cafeRes.items) {
        const score = scoreRelevance(item, lot.name, lot.address);
        if (score < RELEVANCE_THRESHOLD) {
          progress.skippedLowRelevance++;
          continue;
        }
        const sourceId = await hashUrl(item.link);
        pending.push({
          parkingLotId: lot.id,
          source: "naver_cafe",
          sourceId,
          title: stripHtml(item.title),
          content: stripHtml(item.description),
          sourceUrl: item.link,
          author: item.cafename ?? "",
          publishedAt: parsePostdate(item.postdate),
          relevanceScore: score,
        });
      }
    } catch (err) {
      console.error(`\n  카페 검색 실패 (${lot.name}):`, (err as Error).message);
    }

    await sleep(DELAY);

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
    `\n\n✅ 완료! ${progress.savedReviews}건 저장 | API ${progress.totalApiCalls}회 | 제네릭스킵 ${progress.skippedGeneric} | 저관련도스킵 ${progress.skippedLowRelevance}`
  );
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
