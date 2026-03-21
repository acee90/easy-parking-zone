/**
 * 특정 티스토리 블로그 카테고리에서 주차장 글을 크롤링하여 web_sources에 저장
 *
 * Usage:
 *   bun run scripts/crawl-tistory-blog.ts              # 로컬 DB
 *   bun run scripts/crawl-tistory-blog.ts --remote      # 리모트 D1
 *   bun run scripts/crawl-tistory-blog.ts --dry-run     # 저장 없이 미리보기
 *   bun run scripts/crawl-tistory-blog.ts --pages=5     # 5페이지만 크롤링
 */

import { d1Query } from "./lib/d1";
import { buildInsert, flushStatements, esc } from "./lib/sql-flush";
import { resolve } from "path";
import { createHash } from "crypto";

// --- Config ---
const CATEGORY_URL = "https://kingbeginner.tistory.com/category/%EC%83%9D%ED%99%9C%EC%A0%95%EB%B3%B4";
const SOURCE = "tistory_blog";
const AUTHOR = "kingbeginner";
const DELAY_MS = 500; // 요청 간 딜레이 (예의)
const BATCH_SIZE = 50;

const isDryRun = process.argv.includes("--dry-run");
const maxPages = (() => {
  const arg = process.argv.find((a) => a.startsWith("--pages="));
  return arg ? parseInt(arg.split("=")[1]) : Infinity;
})();

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Step 1: 카테고리 페이지에서 글 URL 수집 ---

interface PostLink {
  url: string;
  title: string;
}

async function fetchCategoryPage(page: number): Promise<PostLink[]> {
  const url = `${CATEGORY_URL}?page=${page}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; EasyParkingBot/1.0)" },
  });
  if (!res.ok) return [];
  const html = await res.text();

  const posts: PostLink[] = [];

  // JSON-LD BreadcrumbList에서 추출
  const ldMatches = html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of ldMatches) {
    try {
      const data = JSON.parse(m[1]);
      if (data["@type"] === "BreadcrumbList" && Array.isArray(data.itemListElement)) {
        for (const item of data.itemListElement) {
          const id = item?.item?.["@id"];
          const name = item?.item?.name;
          if (id && name && /tistory\.com\/\d+/.test(id)) {
            posts.push({ url: id, title: name });
          }
        }
      }
    } catch { /* skip */ }
  }

  // 폴백: <a href="/숫자"> 패턴
  if (posts.length === 0) {
    const linkPattern = /href="(https?:\/\/kingbeginner\.tistory\.com\/(\d+))"/g;
    const seen = new Set<string>();
    for (const m of html.matchAll(linkPattern)) {
      if (!seen.has(m[1])) {
        seen.add(m[1]);
        posts.push({ url: m[1], title: "" });
      }
    }
  }

  return posts;
}

// --- Step 2: 개별 글 본문 크롤링 ---

interface PostContent {
  url: string;
  title: string;
  content: string; // 본문 텍스트 (stripped)
  publishedAt: string | null;
}

async function fetchPost(url: string): Promise<PostContent | null> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; EasyParkingBot/1.0)" },
  });
  if (!res.ok) return null;
  const html = await res.text();

  // 제목
  const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/);
  const title = titleMatch ? stripHtml(titleMatch[1]) : "";

  // 본문: article#content (티스토리) → entry-content → article 순으로 시도
  let content = "";
  const contentMatch = html.match(/<article[^>]*id="content"[^>]*>([\s\S]*?)<\/article>/i)
    || html.match(/<div[^>]*class="[^"]*article-view[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/i)
    || html.match(/<div[^>]*class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  if (contentMatch) {
    content = stripHtml(contentMatch[1]).slice(0, 2000); // 2000자 제한
  }

  // 발행일
  const dateMatch = html.match(/<meta\s+property="article:published_time"\s+content="([^"]+)"/)
    || html.match(/(\d{4})[.-](\d{2})[.-](\d{2})/);
  let publishedAt: string | null = null;
  if (dateMatch) {
    const d = dateMatch[1];
    publishedAt = d.length > 10 ? d.slice(0, 10) : d;
  }

  return { url, title, content, publishedAt };
}

// --- Step 3: 주차장 매칭 ---

interface ParkingLot {
  id: string;
  name: string;
  address: string;
}

/**
 * DB 주차장 이름 → 검색용 키 (접미사 제거)
 * "청라호수공원 제1주차장" → "청라호수공원"
 * "진흥로 노상공영주차장" → "진흥로"
 */
function lotNameToKey(name: string): string {
  return name
    .replace(/\s*(제?\d+\s*)?(주차장|공영주차장|노외주차장|노상주차장|환승주차장|부설주차장|하이파킹|주차관리실)\s*\d*$/g, "")
    .replace(/\s*(공영|노외|노상|부설|옥외|지하|지상)\s*$/g, "")
    .replace(/\s*(주차장|주차)\s*\d*$/g, "")
    .trim();
}

/**
 * 본문에서 "OO주차장" 패턴을 추출
 */
function extractParkingNames(text: string): string[] {
  const names = new Set<string>();
  // "OO 주차장", "OO 공영주차장", "OO 노상주차장" 등
  for (const m of text.matchAll(/([\uac00-\ud7a3\d]{2,}(?:\s[\uac00-\ud7a3\d]+){0,3})\s*(?:공영|노상|노외|환승|부설|지하|옥외)?\s*주차장/g)) {
    const name = m[1].trim();
    if (name.length >= 2) names.add(name);
  }
  return [...names];
}

/** DB 주차장 이름 인덱스 (key → lots[]) */
function buildLotIndex(lots: ParkingLot[]): Map<string, ParkingLot[]> {
  const index = new Map<string, ParkingLot[]>();
  for (const lot of lots) {
    const key = lotNameToKey(lot.name).toLowerCase();
    if (key.length < 2) continue;
    const arr = index.get(key) ?? [];
    arr.push(lot);
    index.set(key, arr);
  }
  return index;
}

function matchParkingLots(
  title: string,
  content: string,
  lots: ParkingLot[],
  lotIndex: Map<string, ParkingLot[]>,
): ParkingLot[] {
  const text = title + " " + content;
  const matched = new Map<string, ParkingLot>(); // id → lot

  // 1) 본문에서 주차장명 추출 → DB 인덱스와 매칭
  const extractedNames = extractParkingNames(text);
  for (const name of extractedNames) {
    const nameKey = lotNameToKey(name).toLowerCase();
    if (nameKey.length < 2) continue;

    // 정확 매칭
    const exact = lotIndex.get(nameKey);
    if (exact) {
      for (const lot of exact) matched.set(lot.id, lot);
      continue;
    }

    // 부분 매칭: 추출 이름이 DB 키를 포함하거나 반대
    for (const [dbKey, dbLots] of lotIndex) {
      if (dbKey.length < 3) continue;
      if (nameKey.includes(dbKey) || dbKey.includes(nameKey)) {
        for (const lot of dbLots) matched.set(lot.id, lot);
      }
    }
  }

  // 2) DB 이름 핵심부가 본문에 직접 등장하는지 (보완)
  const textLower = text.toLowerCase();
  for (const lot of lots) {
    if (matched.has(lot.id)) continue;
    const key = lotNameToKey(lot.name);
    if (key.length < 4) continue;
    if (textLower.includes(key.toLowerCase())) {
      matched.set(lot.id, lot);
    }
  }

  // 과다 매칭 방지
  const result = [...matched.values()];
  return result.length > 20 ? result.slice(0, 15) : result;
}

// --- Main ---

async function main() {
  console.log(`[Tistory] ${isDryRun ? "DRY RUN | " : ""}${process.argv.includes("--remote") ? "REMOTE" : "LOCAL"}`);

  // 기존 source_id 로드 (중복 방지)
  const existingRows = d1Query<{ source_id: string }>(
    `SELECT source_id FROM web_sources WHERE source = '${SOURCE}'`
  );
  const existingIds = new Set(existingRows.map((r) => r.source_id));
  console.log(`[Tistory] 기존 ${SOURCE} 레코드: ${existingIds.size}건`);

  // 주차장 목록 로드
  const lots = d1Query<ParkingLot>(
    "SELECT id, name, address FROM parking_lots"
  );
  console.log(`[Tistory] 주차장 DB: ${lots.length}건`);

  // 매칭용 인덱스 빌드
  const lotIndex = buildLotIndex(lots);
  console.log(`[Tistory] 인덱스 키: ${lotIndex.size}건`);

  // Step 1: 카테고리 순회하여 URL 수집
  console.log(`[Tistory] 카테고리 페이지 크롤링 시작 (최대 ${maxPages === Infinity ? "전체" : maxPages}페이지)...`);
  const allPosts: PostLink[] = [];
  let page = 1;
  while (page <= maxPages) {
    const posts = await fetchCategoryPage(page);
    if (posts.length === 0) break;
    allPosts.push(...posts);
    process.stdout.write(`\r  페이지 ${page}: 누적 ${allPosts.length}건`);
    page++;
    await sleep(DELAY_MS);
  }
  console.log(`\n[Tistory] 총 ${allPosts.length}건 URL 수집`);

  // 주차 관련 글만 필터
  const parkingPosts = allPosts.filter(
    (p) => p.title.includes("주차") || p.title === "" // 제목 없으면 일단 포함
  );
  console.log(`[Tistory] 주차 관련: ${parkingPosts.length}건`);

  // 중복 제거
  const newPosts = parkingPosts.filter((p) => !existingIds.has(sha256(p.url)));
  console.log(`[Tistory] 신규 (중복 제외): ${newPosts.length}건`);

  if (newPosts.length === 0) {
    console.log("[Tistory] 새로운 글이 없습니다.");
    return;
  }

  // Step 2 & 3: 본문 크롤링 + 매칭 + 저장
  const tmpPath = resolve(import.meta.dir, ".tmp-tistory.sql");
  let statements: string[] = [];
  let saved = 0;
  let matched = 0;

  for (let i = 0; i < newPosts.length; i++) {
    const post = newPosts[i];
    process.stdout.write(`\r  크롤링 ${i + 1}/${newPosts.length}: ${post.title.slice(0, 30)}...`);

    const content = await fetchPost(post.url);
    if (!content || !content.content) {
      await sleep(DELAY_MS);
      continue;
    }

    // 주차장 매칭
    const matches = matchParkingLots(content.title, content.content, lots, lotIndex);

    if (matches.length > 0) {
      matched++;
      for (const lot of matches) {
        const sourceId = sha256(content.url + ":" + lot.id);
        if (existingIds.has(sourceId)) continue;

        if (isDryRun) {
          console.log(`\n  [DRY] ${lot.name} ← ${content.title.slice(0, 40)}`);
        } else {
          statements.push(
            buildInsert("web_sources", [
              "parking_lot_id", "source", "source_id", "title", "content",
              "source_url", "author", "published_at", "relevance_score",
            ], [
              lot.id, SOURCE, sourceId, content.title, content.content.slice(0, 1000),
              content.url, AUTHOR, content.publishedAt, 50,
            ])
          );
          saved++;
        }
      }
    }

    // 배치 flush
    if (!isDryRun && statements.length >= BATCH_SIZE) {
      flushStatements(tmpPath, statements);
      statements = [];
    }

    await sleep(DELAY_MS);
  }

  // 잔여 flush
  if (!isDryRun && statements.length > 0) {
    flushStatements(tmpPath, statements);
  }

  console.log(`\n\n[Tistory] === 결과 ===`);
  console.log(`  크롤링: ${newPosts.length}건`);
  console.log(`  매칭 성공: ${matched}건`);
  console.log(`  DB 저장: ${saved}건`);
}

main().catch(console.error);
