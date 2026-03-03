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
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";
import {
  searchNaverBlog,
  searchNaverCafe,
  stripHtml,
  parsePostdate,
  hashUrl,
  type NaverSearchItem,
} from "./lib/naver-api";

// --- Config ---
const DELAY = 300; // API 호출 간 딜레이 (ms)
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

// --- Progress ---
function loadProgress(): Progress {
  if (existsSync(PROGRESS_JSON)) {
    return JSON.parse(readFileSync(PROGRESS_JSON, "utf-8"));
  }
  return {
    completedIds: [],
    totalApiCalls: 0,
    savedReviews: 0,
    skippedGeneric: 0,
    skippedLowRelevance: 0,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

function saveProgress(p: Progress) {
  p.lastUpdatedAt = new Date().toISOString();
  writeFileSync(PROGRESS_JSON, JSON.stringify(p));
}

// --- Mapping accuracy helpers ---

/** 제네릭 주차장 이름 감지 — 검색해도 무의미한 결과만 나옴 */
const GENERIC_PATTERNS = [
  /^제?\d+주차장$/,
  /^지하주차장$/,
  /^주차장$/,
  /^옥상주차장$/,
  /^야외주차장$/,
  /^주차타워$/,
  /^기계식주차장$/,
  /^자주식주차장$/,
  /^공영주차장$/,
  /^\S{1,2}주차장$/, // "A주차장", "B1주차장" 등
];

function isGenericName(name: string): boolean {
  const cleaned = name.replace(/\s/g, "");
  return GENERIC_PATTERNS.some((p) => p.test(cleaned));
}

/** 주소에서 동/구/시 추출 — 검색 쿼리 지역 한정용 */
function extractRegion(address: string): string {
  // "서울특별시 강남구 역삼동 123-4" → "강남구 역삼동"
  // "경기도 수원시 팔달구 인계동" → "팔달구 인계동"
  const parts = address.split(/\s+/);
  const regionParts: string[] = [];

  for (const part of parts) {
    // 시/도 레벨은 스킵 (너무 넓음)
    if (/^(서울|부산|대구|인천|광주|대전|울산|세종|경기|강원|충북|충남|전북|전남|경북|경남|제주)/.test(part)) continue;
    // 시 레벨도 스킵
    if (/시$/.test(part) && !/(구$|군$)/.test(part)) continue;
    // 구/군/동/읍/면 → 유용한 지역 키워드
    if (/(구|군|동|읍|면|로|길)$/.test(part)) {
      regionParts.push(part);
      if (regionParts.length >= 2) break;
    }
  }

  return regionParts.join(" ");
}

/** 검색 쿼리 생성 */
function buildSearchQuery(name: string, address: string): string {
  const region = extractRegion(address);
  // "롯데마트 주차장 강남구" 형태
  return `${name} 주차장 ${region}`.trim();
}

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

  // 이름의 핵심 키워드 추출 (2글자 이상 단어)
  const nameKeywords = nameLower
    .replace(/주차장|공영|노외|노상|부설/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  // 이름 키워드가 제목에 포함: 40점
  if (nameKeywords.some((kw) => title.includes(kw))) {
    score += 40;
  }

  // 이름 키워드가 본문에 포함: 20점
  if (nameKeywords.some((kw) => desc.includes(kw))) {
    score += 20;
  }

  // 지역 키워드 일치: 20점
  const region = extractRegion(address).toLowerCase();
  const regionWords = region.split(/\s+/).filter((w) => w.length >= 2);
  if (regionWords.some((rw) => title.includes(rw) || desc.includes(rw))) {
    score += 20;
  }

  // "주차" 포함: 20점
  if (title.includes("주차") || desc.includes("주차")) {
    score += 20;
  }

  return score;
}

// --- DB helpers ---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

function flushToDB(reviews: PendingReview[], progress: Progress) {
  if (reviews.length === 0) return;

  const stmts = reviews
    .map(
      (r) =>
        `INSERT OR IGNORE INTO crawled_reviews (parking_lot_id, source, source_id, title, content, source_url, author, published_at, relevance_score) VALUES ('${esc(r.parkingLotId)}', '${r.source}', '${r.sourceId}', '${esc(r.title)}', '${esc(r.content)}', '${esc(r.sourceUrl)}', '${esc(r.author)}', ${r.publishedAt ? `'${r.publishedAt}'` : "NULL"}, ${r.relevanceScore});`
    )
    .join("\n");

  writeFileSync(TMP_SQL, stmts);
  execSync(`npx wrangler d1 execute parking-db --local --file="${TMP_SQL}"`, {
    stdio: "pipe",
  });
  progress.savedReviews += reviews.length;
}

// --- Main ---
async function main() {
  // 환경변수 체크
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
    console.error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET가 .env에 설정되지 않았습니다.");
    process.exit(1);
  }

  const progress = loadProgress();
  const completedSet = new Set(progress.completedIds);

  // D1에서 주차장 목록 조회
  console.log("주차장 목록 조회 중...");
  const lotsJson = execSync(
    `npx wrangler d1 execute parking-db --local --command "SELECT id, name, address FROM parking_lots" --json`,
    { encoding: "utf-8", maxBuffer: 100 * 1024 * 1024 }
  );
  const parsed = JSON.parse(lotsJson);
  const lots: ParkingRow[] = parsed[0]?.results ?? [];
  console.log(`총 ${lots.length}개 주차장, ${completedSet.size}개 완료됨`);

  let pending: PendingReview[] = [];
  let processed = 0;

  for (const lot of lots) {
    if (completedSet.has(lot.id)) continue;

    // 제네릭 이름 스킵
    if (isGenericName(lot.name)) {
      progress.skippedGeneric++;
      completedSet.add(lot.id);
      progress.completedIds.push(lot.id);
      processed++;
      continue;
    }

    const query = buildSearchQuery(lot.name, lot.address);

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

    // DB flush
    if (pending.length >= DB_FLUSH_SIZE) {
      flushToDB(pending, progress);
      pending = [];
    }

    // 진행상황 출력 (20건마다)
    if (processed % 20 === 0) {
      saveProgress(progress);
      process.stdout.write(
        `\r  ${completedSet.size}/${lots.length} | 저장 ${progress.savedReviews}건 | API ${progress.totalApiCalls}회 | 제네릭스킵 ${progress.skippedGeneric} | 저관련도스킵 ${progress.skippedLowRelevance}`
      );
    }
  }

  // 나머지 flush
  if (pending.length > 0) {
    flushToDB(pending, progress);
  }

  saveProgress(progress);
  if (existsSync(TMP_SQL)) unlinkSync(TMP_SQL);

  console.log(
    `\n\n✅ 완료! ${progress.savedReviews}건 저장 | API ${progress.totalApiCalls}회 | 제네릭스킵 ${progress.skippedGeneric} | 저관련도스킵 ${progress.skippedLowRelevance}`
  );
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
