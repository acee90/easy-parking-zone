/**
 * POI 주차 콘텐츠 수집
 *
 * poi-pilot-result.json의 viable POI에 대해
 * "OO 주차" 네이버 블로그/카페 글을 수집하여 저장
 *
 * 사용법: bun run scripts/collect-poi-content.ts
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import {
  searchNaverBlog,
  searchNaverCafe,
  stripHtml,
  parsePostdate,
} from "./lib/naver-api";
import { sleep } from "./lib/geo";

// --- Config ---
const NAVER_DELAY = 300;
/** POI당 블로그/카페 각각 최대 수집 건수 */
const MAX_PER_SOURCE = 30;
/** 네이버 API display 최대값 */
const PAGE_SIZE = 30;
/** 제목/본문에 주차 관련 키워드가 있어야 유효 */
const PARKING_KEYWORDS = ["주차", "parking", "파킹"];

const DIR = resolve(import.meta.dir);
const inputArg = process.argv.find((a) => a.startsWith("--input="))?.split("=")[1];
const PILOT_FILE = resolve(DIR, inputArg ?? "poi-pilot-result.json");
const outName = inputArg ? inputArg.replace("poi-pilot-", "poi-content-") : "poi-content-result.json";
const OUT_FILE = resolve(DIR, outName);

// --- Types ---
interface PilotPoi {
  name: string;
  address: string;
  lat: number;
  lng: number;
  kakaoId: string;
  categoryLabel: string;
  blogTotal: number;
  cafeTotal: number;
  total: number;
}

interface CollectedPost {
  source: "blog" | "cafe";
  title: string;
  snippet: string;
  link: string;
  date: string | null;
  author: string;
}

interface PoiContent {
  poi: PilotPoi;
  query: string;
  posts: CollectedPost[];
  relevantCount: number;
}

// --- 주차 관련성 필터 ---
function isRelevant(title: string, snippet: string): boolean {
  const text = (title + " " + snippet).toLowerCase();
  return PARKING_KEYWORDS.some((kw) => text.includes(kw));
}

// --- 수집 ---
async function collectForPoi(poi: PilotPoi): Promise<PoiContent> {
  const query = `${poi.name} 주차`;
  const posts: CollectedPost[] = [];
  const seenLinks = new Set<string>();

  // 블로그 수집 (최대 MAX_PER_SOURCE건, 페이징)
  for (let start = 1; start <= MAX_PER_SOURCE; start += PAGE_SIZE) {
    const display = Math.min(PAGE_SIZE, MAX_PER_SOURCE - start + 1);
    try {
      const res = await searchNaverBlog(query, display, start);
      for (const item of res.items) {
        if (seenLinks.has(item.link)) continue;
        const title = stripHtml(item.title);
        const snippet = stripHtml(item.description);
        if (!isRelevant(title, snippet)) continue;
        seenLinks.add(item.link);
        posts.push({
          source: "blog",
          title,
          snippet,
          link: item.link,
          date: parsePostdate(item.postdate),
          author: item.bloggername ?? "",
        });
      }
      if (res.items.length < display) break;
    } catch (e) {
      console.log(`    ⚠️ 블로그 에러: ${e}`);
      break;
    }
    await sleep(NAVER_DELAY);
  }

  // 카페 수집
  for (let start = 1; start <= MAX_PER_SOURCE; start += PAGE_SIZE) {
    const display = Math.min(PAGE_SIZE, MAX_PER_SOURCE - start + 1);
    try {
      const res = await searchNaverCafe(query, display, start);
      for (const item of res.items) {
        if (seenLinks.has(item.link)) continue;
        const title = stripHtml(item.title);
        const snippet = stripHtml(item.description);
        if (!isRelevant(title, snippet)) continue;
        seenLinks.add(item.link);
        posts.push({
          source: "cafe",
          title,
          snippet,
          link: item.link,
          date: parsePostdate(item.postdate),
          author: item.cafename ?? "",
        });
      }
      if (res.items.length < display) break;
    } catch (e) {
      console.log(`    ⚠️ 카페 에러: ${e}`);
      break;
    }
    await sleep(NAVER_DELAY);
  }

  return {
    poi,
    query,
    posts,
    relevantCount: posts.length,
  };
}

// --- 메인 ---
async function main() {
  const pilot = JSON.parse(readFileSync(PILOT_FILE, "utf-8"));
  const pois: PilotPoi[] = pilot.viable;

  console.log(`=== POI 주차 콘텐츠 수집 ===`);
  console.log(`대상 POI: ${pois.length}건`);
  console.log(`POI당 최대: 블로그 ${MAX_PER_SOURCE} + 카페 ${MAX_PER_SOURCE} = ${MAX_PER_SOURCE * 2}건\n`);

  const results: PoiContent[] = [];
  let totalPosts = 0;

  for (let i = 0; i < pois.length; i++) {
    const poi = pois[i];
    console.log(`[${i + 1}/${pois.length}] "${poi.name} 주차" 수집...`);

    const content = await collectForPoi(poi);
    results.push(content);
    totalPosts += content.relevantCount;

    console.log(`  → 주차 관련 ${content.relevantCount}건 (블로그 ${content.posts.filter((p) => p.source === "blog").length} + 카페 ${content.posts.filter((p) => p.source === "cafe").length})`);

    await sleep(NAVER_DELAY);
  }

  // 결과 저장
  const output = {
    meta: {
      createdAt: new Date().toISOString(),
      totalPois: pois.length,
      totalPosts,
      maxPerSource: MAX_PER_SOURCE,
      parkingKeywords: PARKING_KEYWORDS,
    },
    results: results.map((r) => ({
      name: r.poi.name,
      address: r.poi.address,
      lat: r.poi.lat,
      lng: r.poi.lng,
      kakaoId: r.poi.kakaoId,
      categoryLabel: r.poi.categoryLabel,
      query: r.query,
      relevantCount: r.relevantCount,
      posts: r.posts,
    })),
  };

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  // 요약
  console.log("\n" + "=".repeat(50));
  console.log("📋 수집 요약");
  console.log("=".repeat(50));
  console.log(`총 POI: ${pois.length}건`);
  console.log(`총 수집 콘텐츠: ${totalPosts}건`);
  console.log(`평균 POI당: ${(totalPosts / pois.length).toFixed(1)}건`);

  console.log("\n📊 POI별 수집 현황:");
  for (const r of results.sort((a, b) => b.relevantCount - a.relevantCount)) {
    console.log(`  ${r.poi.name} — ${r.relevantCount}건`);
  }

  console.log(`\n💾 결과 저장: ${OUT_FILE}`);
}

main().catch((e) => {
  console.error("오류 발생:", e);
  process.exit(1);
});
