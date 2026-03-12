/**
 * POI 기반 주차 정보 수집 파일럿
 *
 * 1단계: 카카오 API로 카테고리별 POI 후보 수집
 * 2단계: 각 POI에 대해 "OO 주차" 네이버 블로그/카페 검색량 확인
 * 3단계: 검색 결과 N건 이상인 POI만 필터 → 유의미한 수집 대상
 *
 * 사용법: bun run scripts/collect-poi-pilot.ts
 */
import { writeFileSync } from "fs";
import { resolve } from "path";
import { searchNaverBlog, searchNaverCafe, stripHtml } from "./lib/naver-api";
import { sleep } from "./lib/geo";

// --- Config ---
const KAKAO_KEY = process.env.KAKAO_REST_API_KEY;
if (!KAKAO_KEY) {
  console.error("KAKAO_REST_API_KEY가 .env에 설정되지 않았습니다.");
  process.exit(1);
}

const NAVER_DELAY = 300; // 네이버 API 호출 간격
const KAKAO_DELAY = 100;
const MIN_SEARCH_RESULTS = 5; // 이 이상이면 유의미한 POI

// --category 플래그 (카테고리 정의보다 먼저 파싱)
const categoryArgIdx = process.argv.indexOf("--category");
const categoryArg = process.argv.find((a) => a.startsWith("--category="))?.split("=")[1]
  ?? (categoryArgIdx >= 0 ? process.argv[categoryArgIdx + 1] : undefined);

const OUT_DIR = resolve(import.meta.dir);
const OUT_FILE = resolve(OUT_DIR, categoryArg ? `poi-pilot-${categoryArg}.json` : "poi-pilot-result.json");

// --- 파일럿 대상 카테고리 & 지역 ---
// 카카오 카테고리 코드: https://developers.kakao.com/docs/latest/ko/local/dev-guide#search-by-category
// SW8 = 지하철역, 없으면 keyword 검색으로 대체
interface PoiCategory {
  label: string;
  /** 카카오 키워드 검색 쿼리 패턴. {region}이 지역명으로 치환됨 */
  queryPattern: string;
  /** 카카오 category_name에 이 키워드 중 하나라도 포함되어야 POI로 인정 */
  categoryFilter?: string[];
  /** place_name에 이 키워드가 포함되면 제외 */
  nameExclude?: string[];
  /** place_name 최대 글자수 (초과 시 하위시설로 간주하여 제외) */
  maxNameLength?: number;
}

/** 300m 이내 같은 카테고리 POI 중복 제거 반경 */
const DEDUP_RADIUS_M = 300;

const CATEGORIES: PoiCategory[] = [
  {
    label: "기차역",
    queryPattern: "{region} 기차역",
    categoryFilter: ["기차역", "지하철역", "철도"],
  },
  {
    label: "대형병원",
    queryPattern: "{region} 대학병원",
    categoryFilter: ["병원", "의료"],
    maxNameLength: 15,
  },
  {
    label: "쇼핑몰",
    queryPattern: "{region} 백화점",
    categoryFilter: ["백화점", "대형마트", "아울렛", "면세점", "쇼핑몰"],
  },
  {
    label: "터미널",
    queryPattern: "{region} 터미널",
    categoryFilter: ["터미널", "교통"],
    nameExclude: ["트럭", "화물", "교차로", "신공항"],
  },
  // --- 확장 카테고리 ---
  {
    label: "대형마트",
    queryPattern: "{region} 대형마트",
    categoryFilter: ["대형마트", "마트", "슈퍼마켓", "창고형매장"],
    nameExclude: ["편의점", "미니", "슈퍼"],
  },
  {
    label: "놀이공원",
    queryPattern: "{region} 놀이공원",
    categoryFilter: ["놀이공원", "테마파크", "공원", "유원지", "동물원", "식물원", "아쿠아리움"],
    nameExclude: ["어린이집", "키즈카페", "실내"],
  },
  {
    label: "경기장",
    queryPattern: "{region} 경기장",
    categoryFilter: ["경기장", "체육관", "스포츠", "운동장", "구장", "돔"],
    nameExclude: ["헬스", "피트니스", "수영장", "볼링"],
  },
  {
    label: "공연장",
    queryPattern: "{region} 공연장",
    categoryFilter: ["공연장", "전시", "문화", "극장", "아트", "컨벤션"],
    nameExclude: ["CGV", "메가박스", "롯데시네마", "영화"],
  },
  {
    label: "대학교",
    queryPattern: "{region} 대학교",
    categoryFilter: ["대학교", "대학"],
    nameExclude: ["학원", "어학원", "입시", "부속"],
    maxNameLength: 12,
  },
  {
    label: "관광명소",
    queryPattern: "{region} 관광명소",
    categoryFilter: ["관광", "명소", "궁", "타워", "공원", "문화재", "유적"],
    nameExclude: ["호텔", "모텔", "게스트하우스"],
  },
  {
    label: "전통시장",
    queryPattern: "{region} 전통시장",
    categoryFilter: ["시장", "전통시장"],
    nameExclude: ["마트", "편의점", "슈퍼"],
  },
];

// 파일럿: 서울만
const PILOT_REGIONS = ["서울"];

// --category 플래그로 특정 카테고리만 실행 가능
const PILOT_CATEGORIES = categoryArg
  ? CATEGORIES.filter((c) => c.label === categoryArg)
  : CATEGORIES;

// --- Kakao API ---
interface KakaoKeywordPlace {
  id: string;
  place_name: string;
  category_name: string;
  address_name: string;
  road_address_name: string;
  x: string; // lng
  y: string; // lat
  phone: string;
  place_url: string;
}

interface KakaoKeywordResponse {
  meta: { total_count: number; pageable_count: number; is_end: boolean };
  documents: KakaoKeywordPlace[];
}

async function searchKakaoKeyword(
  query: string,
  page = 1,
): Promise<KakaoKeywordResponse> {
  const params = new URLSearchParams({
    query,
    page: String(page),
    size: "15",
  });
  const res = await fetch(
    `https://dapi.kakao.com/v2/local/search/keyword.json?${params}`,
    { headers: { Authorization: `KakaoAK ${KAKAO_KEY}` } },
  );
  if (!res.ok) {
    if (res.status === 429) {
      console.log("  카카오 rate limit, 3초 대기...");
      await sleep(3000);
      return searchKakaoKeyword(query, page);
    }
    throw new Error(`Kakao API ${res.status}: ${await res.text()}`);
  }
  return res.json() as Promise<KakaoKeywordResponse>;
}

// --- POI 후보 수집 ---
interface PoiCandidate {
  kakaoId: string;
  name: string;
  category: string;
  categoryLabel: string;
  address: string;
  lat: number;
  lng: number;
  phone: string;
}

async function collectPoiCandidates(
  category: PoiCategory,
  regions: string[],
): Promise<PoiCandidate[]> {
  const candidates: PoiCandidate[] = [];
  const seenIds = new Set<string>();

  for (const region of regions) {
    const query = category.queryPattern.replace("{region}", region);
    console.log(`\n🔍 카카오 검색: "${query}"`);

    let page = 1;
    let isEnd = false;

    while (!isEnd && page <= 3) {
      const res = await searchKakaoKeyword(query, page);
      console.log(
        `  페이지 ${page}: ${res.documents.length}건 (총 ${res.meta.total_count}건)`,
      );

      for (const doc of res.documents) {
        if (seenIds.has(doc.id)) continue;

        // 카테고리 필터: 관련 없는 장소 (카페, 편의점 등) 제외
        if (category.categoryFilter) {
          const catName = doc.category_name.toLowerCase();
          const match = category.categoryFilter.some((f) =>
            catName.includes(f.toLowerCase()),
          );
          if (!match) {
            console.log(`    ⏭️ 제외: ${doc.place_name} (${doc.category_name})`);
            continue;
          }
        }

        // 이름 제외 필터
        if (category.nameExclude) {
          const excluded = category.nameExclude.some((kw) => doc.place_name.includes(kw));
          if (excluded) {
            console.log(`    ⏭️ 이름제외: ${doc.place_name}`);
            continue;
          }
        }

        // 이름 길이 필터 (하위시설 제외)
        if (category.maxNameLength && doc.place_name.length > category.maxNameLength) {
          console.log(`    ⏭️ 이름초과(${doc.place_name.length}자): ${doc.place_name}`);
          continue;
        }

        seenIds.add(doc.id);
        candidates.push({
          kakaoId: doc.id,
          name: doc.place_name,
          category: doc.category_name,
          categoryLabel: category.label,
          address: doc.address_name,
          lat: parseFloat(doc.y),
          lng: parseFloat(doc.x),
          phone: doc.phone,
        });
      }

      isEnd = res.meta.is_end;
      page++;
      await sleep(KAKAO_DELAY);
    }
  }

  return candidates;
}

// --- 좌표 기반 중복 제거 ---
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** 같은 카테고리 내 DEDUP_RADIUS_M 이내 POI는 이름이 가장 짧은 것(대표명)만 남김 */
function dedup(candidates: PoiCandidate[]): PoiCandidate[] {
  const byCategory = new Map<string, PoiCandidate[]>();
  for (const c of candidates) {
    const arr = byCategory.get(c.categoryLabel) ?? [];
    arr.push(c);
    byCategory.set(c.categoryLabel, arr);
  }

  const result: PoiCandidate[] = [];
  for (const [cat, pois] of byCategory) {
    // 이름 길이 오름차순 — 짧은 이름(대표명)이 대표로 남음
    const sorted = [...pois].sort((a, b) => a.name.length - b.name.length);
    const kept: PoiCandidate[] = [];
    const removed: string[] = [];

    for (const poi of sorted) {
      const tooClose = kept.some(
        (k) => haversineM(k.lat, k.lng, poi.lat, poi.lng) < DEDUP_RADIUS_M,
      );
      if (tooClose) {
        removed.push(poi.name);
      } else {
        kept.push(poi);
      }
    }

    if (removed.length > 0) {
      console.log(`\n🔀 [${cat}] 중복 제거 ${removed.length}건: ${removed.join(", ")}`);
    }
    result.push(...kept);
  }

  return result;
}

// --- 네이버 검색량 확인 ---
interface SearchVolume {
  blogTotal: number;
  cafeTotal: number;
  total: number;
  blogSamples: { title: string; snippet: string; link: string }[];
}

async function checkSearchVolume(poiName: string): Promise<SearchVolume> {
  const query = `${poiName} 주차`;

  const [blogRes, cafeRes] = await Promise.all([
    searchNaverBlog(query, 5),
    sleep(NAVER_DELAY).then(() => searchNaverCafe(query, 5)),
  ]);

  const blogSamples = blogRes.items.map((item) => ({
    title: stripHtml(item.title),
    snippet: stripHtml(item.description),
    link: item.link,
  }));

  return {
    blogTotal: blogRes.total,
    cafeTotal: cafeRes.total,
    total: blogRes.total + cafeRes.total,
    blogSamples,
  };
}

// --- 메인 ---
interface PoiResult {
  poi: PoiCandidate;
  searchVolume: SearchVolume;
  isViable: boolean; // 수집 대상 여부
}

async function main() {
  console.log("=== POI 기반 주차 정보 수집 파일럿 ===\n");
  console.log(`대상 지역: ${PILOT_REGIONS.join(", ")}`);
  console.log(`대상 카테고리: ${PILOT_CATEGORIES.map((c) => c.label).join(", ")}`);
  console.log(`최소 검색 결과 기준: ${MIN_SEARCH_RESULTS}건\n`);

  // 1단계: POI 후보 수집
  console.log("📍 1단계: POI 후보 수집");
  const allCandidates: PoiCandidate[] = [];

  for (const cat of PILOT_CATEGORIES) {
    const candidates = await collectPoiCandidates(cat, PILOT_REGIONS);
    allCandidates.push(...candidates);
  }

  console.log(`\n총 POI 후보 (중복 제거 전): ${allCandidates.length}건`);

  // 1.5단계: 좌표 기반 중복 제거
  const dedupedCandidates = dedup(allCandidates);
  console.log(`중복 제거 후: ${dedupedCandidates.length}건`);

  // 2단계: 검색량 확인
  console.log("\n📊 2단계: 네이버 검색량 확인");
  const results: PoiResult[] = [];

  for (let i = 0; i < dedupedCandidates.length; i++) {
    const poi = dedupedCandidates[i];
    console.log(
      `  [${i + 1}/${dedupedCandidates.length}] "${poi.name}" → "${poi.name} 주차" 검색...`,
    );

    const searchVolume = await checkSearchVolume(poi.name);
    const isViable = searchVolume.total >= MIN_SEARCH_RESULTS;

    console.log(
      `    블로그 ${searchVolume.blogTotal}건 + 카페 ${searchVolume.cafeTotal}건 = 총 ${searchVolume.total}건 ${isViable ? "✅" : "❌"}`,
    );

    results.push({ poi, searchVolume, isViable });
    await sleep(NAVER_DELAY);
  }

  // 3단계: 결과 정리
  const viable = results.filter((r) => r.isViable);
  const notViable = results.filter((r) => !r.isViable);

  console.log("\n" + "=".repeat(50));
  console.log("📋 결과 요약");
  console.log("=".repeat(50));
  console.log(`총 POI 후보: ${results.length}건`);
  console.log(`수집 대상 (${MIN_SEARCH_RESULTS}건+): ${viable.length}건`);
  console.log(`제외: ${notViable.length}건`);

  console.log("\n✅ 수집 대상 POI:");
  for (const r of viable.sort((a, b) => b.searchVolume.total - a.searchVolume.total)) {
    console.log(
      `  ${r.poi.name} — 블로그 ${r.searchVolume.blogTotal} + 카페 ${r.searchVolume.cafeTotal} = ${r.searchVolume.total}건`,
    );
    for (const s of r.searchVolume.blogSamples.slice(0, 2)) {
      console.log(`    📝 ${s.title}`);
    }
  }

  if (notViable.length > 0) {
    console.log("\n❌ 제외 POI:");
    for (const r of notViable) {
      console.log(`  ${r.poi.name} — ${r.searchVolume.total}건`);
    }
  }

  // 파일 저장
  const output = {
    meta: {
      pilot: true,
      regions: PILOT_REGIONS,
      categories: PILOT_CATEGORIES.map((c) => c.label),
      minSearchResults: MIN_SEARCH_RESULTS,
      createdAt: new Date().toISOString(),
    },
    summary: {
      totalCandidates: results.length,
      viableCount: viable.length,
      excludedCount: notViable.length,
    },
    viable: viable
      .sort((a, b) => b.searchVolume.total - a.searchVolume.total)
      .map((r) => ({
        name: r.poi.name,
        address: r.poi.address,
        lat: r.poi.lat,
        lng: r.poi.lng,
        kakaoId: r.poi.kakaoId,
        categoryLabel: r.poi.categoryLabel,
        blogTotal: r.searchVolume.blogTotal,
        cafeTotal: r.searchVolume.cafeTotal,
        total: r.searchVolume.total,
        blogSamples: r.searchVolume.blogSamples,
      })),
    excluded: notViable.map((r) => ({
      name: r.poi.name,
      address: r.poi.address,
      total: r.searchVolume.total,
    })),
  };

  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));
  console.log(`\n💾 결과 저장: ${OUT_FILE}`);
}

main().catch((e) => {
  console.error("오류 발생:", e);
  process.exit(1);
});
