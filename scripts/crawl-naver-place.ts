/**
 * 네이버 플레이스 리뷰 크롤링 (Playwright)
 *
 * - curated 주차장(hell/easy)부터 시작, 이후 전체 확장 가능
 * - 네이버 플레이스 검색 → placeId 획득 → 리뷰 페이지 스크래핑
 * - 진행상황을 scripts/naver-place-progress.json에 저장 → 중단 후 재개 가능
 *
 * 사용법:
 *   bun run scripts/crawl-naver-place.ts              # 로컬 D1
 *   bun run scripts/crawl-naver-place.ts --remote      # 리모트 D1
 *   bun run scripts/crawl-naver-place.ts --all         # curated 외 전체 주차장
 */
import { resolve } from "path";
import { chromium, type Page } from "playwright";
import { hashUrl } from "./lib/naver-api";
import { d1Query, isRemote } from "./lib/d1";
import { loadProgress, saveProgress } from "./lib/progress";
import { buildInsert, flushStatements } from "./lib/sql-flush";

// --- Config ---
const PAGE_DELAY = 2000;
const SCROLL_DELAY = 1500;
const MAX_REVIEWS_PER_LOT = 20;
const DB_FLUSH_SIZE = 30;

const PROGRESS_JSON = resolve(import.meta.dir, "naver-place-progress.json");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-naver-place.sql");

// --- Types ---
interface ParkingRow {
  id: string;
  name: string;
  address: string;
}

interface Progress {
  completedIds: string[];
  matchedCount: number;
  unmatchedCount: number;
  savedReviews: number;
  startedAt: string;
  lastUpdatedAt: string;
}

interface ScrapedReview {
  text: string;
  visitInfo?: string;
}

interface PendingReview {
  parkingLotId: string;
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

// --- DB flush ---
const pendingReviews: PendingReview[] = [];

async function flushToDB() {
  if (pendingReviews.length === 0) return;

  const stmts = pendingReviews.map((r) =>
    buildInsert("crawled_reviews", REVIEW_COLUMNS, [
      r.parkingLotId, "naver_place", r.sourceId, r.title, r.content,
      r.sourceUrl, r.author, r.publishedAt, r.relevanceScore,
    ])
  );

  flushStatements(TMP_SQL, stmts);
  pendingReviews.length = 0;
}

// --- Playwright helpers ---

/** 주소에서 구/군/시 추출 (네이버 플레이스 검색 특화) */
function extractDistrict(address: string): string {
  const match = address.match(
    /(?:서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)\S*\s+(\S+[구군시])/
  );
  return match?.[1] ?? "";
}

/** 네이버 지도 검색으로 placeId 획득 (m.map.naver.com) */
async function searchPlaceId(
  page: Page,
  name: string,
  address: string
): Promise<string | null> {
  const addrShort = extractDistrict(address);
  const query = addrShort ? `${name} ${addrShort}` : name;

  const searchUrl = `https://m.map.naver.com/search?query=${encodeURIComponent(query + " 주차장")}`;
  await page.goto(searchUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(PAGE_DELAY);

  const placeIds = await page.evaluate(() => {
    const links = document.querySelectorAll('a[href*="/place/"]');
    const ids: { id: string; text: string }[] = [];
    for (const link of links) {
      const href = link.getAttribute("href");
      const match = href?.match(/\/place\/(\d+)/);
      if (match) {
        const text = (link as HTMLElement).textContent?.trim() ?? "";
        if (text && !["가격", ""].includes(text)) {
          ids.push({ id: match[1], text });
        }
      }
    }
    return ids;
  });

  if (placeIds.length === 0) return null;

  const nameClean = name.replace(/\s+/g, "").toLowerCase();
  const best = placeIds.find((p) =>
    p.text.replace(/\s+/g, "").toLowerCase().includes(nameClean)
  );

  return best?.id ?? placeIds[0].id;
}

/** 리뷰 페이지에서 리뷰 텍스트 스크래핑 */
async function scrapeReviews(
  page: Page,
  placeId: string
): Promise<ScrapedReview[]> {
  const reviewUrl = `https://m.place.naver.com/place/${placeId}/review/visitor`;
  await page.goto(reviewUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(PAGE_DELAY);

  for (let i = 0; i < 3; i++) {
    try {
      const moreBtn = await page.$('a[class*="fvwqf"]');
      if (moreBtn) {
        await moreBtn.click();
        await page.waitForTimeout(SCROLL_DELAY);
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  const reviews = await page.$$eval(
    ".pui__vn15t2",
    (els, max) =>
      els.slice(0, max).map((el) => ({
        text: (el as HTMLElement).innerText?.trim() ?? "",
      })),
    MAX_REVIEWS_PER_LOT
  );

  return reviews.filter((r) => r.text.length > 10);
}

// --- Relevance scoring ---
const PARKING_KEYWORDS = [
  "주차", "주차장", "좁", "넓", "진입", "출차", "나선", "회전", "경사", "램프",
  "기계식", "자주식", "지하", "골뱅이", "초보", "무서", "어렵", "쉬", "편리",
  "복잡", "통로", "주차면", "기둥", "만차", "빈자리", "주차비", "요금", "무료", "발렛",
];

function scoreRelevance(text: string): number {
  const lower = text.toLowerCase();
  let score = 30;

  for (const kw of PARKING_KEYWORDS) {
    if (lower.includes(kw)) score += 5;
  }

  if (text.length > 50) score += 5;
  if (text.length > 100) score += 5;
  if (text.length > 200) score += 5;

  return Math.min(score, 100);
}

// --- Main ---
async function main() {
  const allMode = process.argv.includes("--all");
  const progress = loadProgress<Progress>(PROGRESS_JSON, {
    completedIds: [],
    matchedCount: 0,
    unmatchedCount: 0,
    savedReviews: 0,
    startedAt: "",
    lastUpdatedAt: "",
  });
  const completedSet = new Set(progress.completedIds);

  let lots: ParkingRow[];
  if (allMode) {
    lots = d1Query<ParkingRow>(
      "SELECT id, name, address FROM parking_lots ORDER BY id"
    );
  } else {
    lots = d1Query<ParkingRow>(
      "SELECT id, name, address FROM parking_lots WHERE curation_tag IS NOT NULL ORDER BY id"
    );
  }

  const remaining = lots.filter((l) => !completedSet.has(l.id));
  console.log(
    `[naver-place] 대상 ${lots.length}개 중 ${remaining.length}개 남음 (${isRemote ? "remote" : "local"})`
  );

  if (remaining.length === 0) {
    console.log("[naver-place] 모든 주차장 처리 완료!");
    return;
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    viewport: { width: 390, height: 844 },
    locale: "ko-KR",
  });
  const page = await context.newPage();

  try {
    for (const lot of remaining) {
      console.log(`\n[${lot.id}] ${lot.name}`);

      const placeId = await searchPlaceId(page, lot.name, lot.address);
      if (!placeId) {
        console.log(`  → 플레이스 매칭 실패`);
        progress.unmatchedCount++;
        progress.completedIds.push(lot.id);
        saveProgress(PROGRESS_JSON, progress);
        continue;
      }

      console.log(`  → placeId: ${placeId}`);
      progress.matchedCount++;

      const reviews = await scrapeReviews(page, placeId);
      console.log(`  → 리뷰 ${reviews.length}개 수집`);

      const placeUrl = `https://m.place.naver.com/place/${placeId}/review/visitor`;
      for (const review of reviews) {
        const score = scoreRelevance(review.text);
        if (score < 30) continue;

        const sourceId = await hashUrl(`naver_place_${placeId}_${review.text.slice(0, 50)}`);
        pendingReviews.push({
          parkingLotId: lot.id,
          sourceId,
          title: `네이버 플레이스 리뷰 - ${lot.name}`,
          content: review.text.slice(0, 1000),
          sourceUrl: placeUrl,
          author: "네이버 플레이스 방문자",
          publishedAt: null,
          relevanceScore: score,
        });
      }

      progress.savedReviews += reviews.length;
      progress.completedIds.push(lot.id);

      if (pendingReviews.length >= DB_FLUSH_SIZE) {
        await flushToDB();
        console.log(`  → DB flush 완료`);
      }

      saveProgress(PROGRESS_JSON, progress);
      await page.waitForTimeout(PAGE_DELAY);
    }

    await flushToDB();
  } finally {
    await browser.close();
  }

  console.log(`\n=== 완료 ===`);
  console.log(`매칭 성공: ${progress.matchedCount}`);
  console.log(`매칭 실패: ${progress.unmatchedCount}`);
  console.log(`수집 리뷰: ${progress.savedReviews}`);
}

main().catch((err) => {
  console.error("[naver-place] 에러:", err);
  process.exit(1);
});
