/**
 * 네이버 카페 심화 수집 — 초보운전 커뮤니티 주차장 시그널
 *
 * Phase 1: 카페 검색 API로 "초보운전 주차장 추천" 등 키워드 검색
 *   → snippet에서 주차장명 추출 → DB 매칭 → 시그널 저장
 *
 * 사용법:
 *   bun run scripts/crawl-cafe-community.ts           # 로컬 D1
 *   bun run scripts/crawl-cafe-community.ts --remote   # 리모트 D1
 *   bun run scripts/crawl-cafe-community.ts --dry-run  # API만 호출, DB 저장 안함
 */
import { resolve } from "path";
import { searchNaverCafe, stripHtml } from "./lib/naver-api";
import { d1Query, isRemote } from "./lib/d1";
import { loadProgress, saveProgress } from "./lib/progress";
import { sleep } from "./lib/geo";

// --- Config ---
const DELAY = 350; // API 호출 간격 (ms)
const RESULTS_PER_PAGE = 100; // 페이지당 결과 수
const MAX_PAGES = 10; // 키워드당 최대 페이지 (100 * 10 = 1000건)
const DB_FLUSH_SIZE = 50;
const DRY_RUN = process.argv.includes("--dry-run");

const PROGRESS_JSON = resolve(import.meta.dir, "cafe-community-progress.json");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-cafe-community.sql");

// --- 검색 키워드 ---
// 지역 무관 일반 키워드
const GENERAL_KEYWORDS = [
  "초보운전 주차장 추천",
  "초보운전 주차 쉬운 곳",
  "초보운전 주차 쉬운 주차장",
  "초보 주차 추천",
  "초보운전 주차 팁 추천",
  "주차 쉬운 곳 추천",
  "주차 초보 어디",
  "초보 주차장 추천해주세요",
  "초보운전 주차장 어디",
  "초보운전 주차하기 좋은",
  "초보운전 주차 힘든 곳",
  "초보운전 주차장 비추",
  "주차 못하겠다 좁아",
  "주차장 차 긁었어요",
  "주차 실패 후기",
  "주차장 너무 좁아",
  "기계식 주차 초보",
  "지하주차장 초보 무서워",
  "주차장 경사 무서워",
  "초보운전 주차 포기",
];

// 주요 지역 × 초보 키워드 조합
const REGIONS = [
  "서울", "강남", "홍대", "잠실", "여의도", "명동", "이태원", "신촌", "건대",
  "판교", "분당", "수원", "인천", "부산", "대구", "대전", "광주", "제주",
  "해운대", "센텀시티", "동탄", "일산", "파주",
];

const REGION_SUFFIXES = [
  "초보 주차",
  "주차 쉬운 곳",
  "주차장 추천 초보",
  "주차 힘든",
];

function buildKeywords(): string[] {
  const keywords = [...GENERAL_KEYWORDS];
  for (const region of REGIONS) {
    for (const suffix of REGION_SUFFIXES) {
      keywords.push(`${region} ${suffix}`);
    }
  }
  return keywords;
}

// --- 주차장 이름 매칭 ---
interface ParkingLot {
  id: string;
  name: string;
  address: string;
  nameKeywords: string[]; // 핵심 이름 키워드
  regionKeywords: string[]; // 지역 키워드 (구/동)
}

/** 주차장 이름에서 핵심 키워드 추출 */
function extractNameKeywords(name: string): string[] {
  return name
    .replace(/주차장|공영|노외|노상|부설|제?\d+/g, "")
    .split(/[\s()·,]+/)
    .filter((w) => w.length >= 2);
}

/** 주소에서 지역 키워드 추출 */
function extractRegionKeywords(address: string): string[] {
  const parts = address.split(/\s+/);
  return parts
    .filter((p) => /(구|군|동|읍|면)$/.test(p))
    .map((p) => p.toLowerCase());
}

/**
 * 흔한 키워드 — 4글자 이상이지만 너무 일반적이라 지역 보강 필요.
 * 이 키워드만으로 매칭하면 전국 체인점/시설이 전부 매칭됨.
 */
const COMMON_KEYWORDS = new Set([
  // 대형마트/백화점
  "롯데백화점", "롯데마트", "롯데시네마", "롯데아울렛",
  "현대백화점", "갤러리아", "신세계",
  "홈플러스", "이마트", "코스트코", "트레이더스",
  // 주차 시설 유형
  "주차타워", "주차빌딩", "주차대행",
  // 공공시설
  "시청주차장", "역세권", "터미널",
  // 아파트 브랜드
  "한신아파트", "삼성아파트", "현대아파트", "대우아파트",
  // 기타 흔한 4글자
  "인천공항", "김포공항", "해수욕장", "리조트",
]);

/** 역인덱스 + 엄격 매칭 */
interface LotsIndex {
  /** 키워드 → 해당 키워드를 가진 주차장 목록 */
  byKeyword: Map<string, ParkingLot[]>;
  /** 전체 키워드 목록 (검색 순회용) */
  allKeywords: string[];
}

function buildLotsIndex(rawLots: { id: string; name: string; address: string }[]): LotsIndex {
  const byKeyword = new Map<string, ParkingLot[]>();
  let prepared = 0;

  for (const raw of rawLots) {
    const cleaned = raw.name.replace(/주차장|공영|노외|노상|부설|\s/g, "");
    if (cleaned.length < 2) continue;

    const lot: ParkingLot = {
      ...raw,
      nameKeywords: extractNameKeywords(raw.name).map((w) => w.toLowerCase()),
      regionKeywords: extractRegionKeywords(raw.address),
    };

    // 3글자 이상 키워드만 인덱싱
    for (const kw of lot.nameKeywords.filter((w) => w.length >= 3)) {
      if (!byKeyword.has(kw)) byKeyword.set(kw, []);
      byKeyword.get(kw)!.push(lot);
    }
    prepared++;
  }

  console.log(`  인덱싱: ${prepared}개 주차장, ${byKeyword.size}개 키워드`);
  return { byKeyword, allKeywords: [...byKeyword.keys()] };
}

/**
 * snippet에서 DB 주차장 매칭 (역인덱스 + 엄격 조건).
 *
 * - 4글자+ 키워드가 텍스트에 포함 → 직접 매칭
 * - 3글자 키워드가 포함 → 해당 주차장의 지역 키워드도 포함되어야 매칭
 * - "주차" 없으면 스킵
 * - 결과당 최대 5개 주차장 매칭 (너무 많으면 대부분 false positive)
 */
function findMatchingLots(text: string, index: LotsIndex): ParkingLot[] {
  const textLower = text.toLowerCase();
  if (!textLower.includes("주차")) return [];

  const matchedIds = new Set<string>();
  const matches: ParkingLot[] = [];
  const MAX_MATCHES = 5;

  for (const kw of index.allKeywords) {
    if (matches.length >= MAX_MATCHES) break;
    if (!textLower.includes(kw)) continue;

    const lots = index.byKeyword.get(kw)!;
    for (const lot of lots) {
      if (matches.length >= MAX_MATCHES) break;
      if (matchedIds.has(lot.id)) continue;

      if (kw.length >= 4 && !COMMON_KEYWORDS.has(kw)) {
        // 4글자+ 고유 키워드 (흔한 키워드 제외) → 직접 매칭
        matchedIds.add(lot.id);
        matches.push(lot);
      } else {
        // 3글자 → 지역 키워드 보강 필요
        if (lot.regionKeywords.some((rk) => textLower.includes(rk))) {
          matchedIds.add(lot.id);
          matches.push(lot);
        }
      }
    }
  }

  return matches;
}

// --- 시그널 타입 ---
type Sentiment = "positive" | "negative" | "neutral";

/** 텍스트에서 긍/부정 판단 */
function detectSentiment(text: string): Sentiment {
  const positive = ["추천", "쉬운", "넓은", "여유", "편한", "좋은", "좋아요", "괜찮", "쾌적"];
  const negative = ["비추", "좁은", "힘든", "어려", "무서", "긁었", "못하겠", "포기", "최악", "실패", "주의"];

  const lower = text.toLowerCase();
  const posCount = positive.filter((w) => lower.includes(w)).length;
  const negCount = negative.filter((w) => lower.includes(w)).length;

  if (posCount > negCount) return "positive";
  if (negCount > posCount) return "negative";
  return "neutral";
}

// --- 개별 시그널 수집 ---
interface CafeSignal {
  parkingLotId: string;
  lotName: string;
  address: string;
  url: string;
  title: string;
  snippet: string;
  aiSentiment: Sentiment;
}

const signals: CafeSignal[] = [];
const seenPairs = new Set<string>(); // "lotId|url" 중복 방지

function addSignal(lot: ParkingLot, url: string, title: string, snippet: string, sentiment: Sentiment) {
  const key = `${lot.id}|${url}`;
  if (seenPairs.has(key)) return;
  seenPairs.add(key);

  signals.push({
    parkingLotId: lot.id,
    lotName: lot.name,
    address: lot.address,
    url,
    title,
    snippet,
    aiSentiment: sentiment,
  });
}

// --- Progress ---
interface Progress {
  completedKeywords: string[];
  totalApiCalls: number;
  totalResults: number;
  matchedResults: number;
  unmatchedResults: number;
  startedAt: string;
  lastUpdatedAt: string;
}

// --- Main ---
async function main() {
  if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
    console.error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET가 .env에 설정되지 않았습니다.");
    process.exit(1);
  }

  const keywords = buildKeywords();
  console.log(`키워드 ${keywords.length}개 준비`);

  if (isRemote) console.log("🌐 리모트 D1 모드");
  if (DRY_RUN) console.log("🧪 DRY RUN 모드 (DB 저장 안함)");

  // 주차장 인덱스 구축
  console.log("주차장 인덱스 구축 중...");
  const rawLots: { id: string; name: string; address: string }[] = d1Query(
    "SELECT id, name, address FROM parking_lots"
  );
  const index = buildLotsIndex(rawLots);
  console.log();

  const progress = loadProgress<Progress>(PROGRESS_JSON, {
    completedKeywords: [],
    totalApiCalls: 0,
    totalResults: 0,
    matchedResults: 0,
    unmatchedResults: 0,
    startedAt: "",
    lastUpdatedAt: "",
  });
  const completedSet = new Set(progress.completedKeywords);

  let keywordIdx = 0;

  for (const keyword of keywords) {
    keywordIdx++;
    if (completedSet.has(keyword)) continue;

    process.stdout.write(`[${keywordIdx}/${keywords.length}] "${keyword}"`);

    let pageResults = 0;
    let keywordMatches = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const start = (page - 1) * RESULTS_PER_PAGE + 1;
      // 네이버 검색 API: start + display <= 1100
      if (start + RESULTS_PER_PAGE > 1100) break;

      try {
        const res = await searchNaverCafe(keyword, RESULTS_PER_PAGE, start);
        progress.totalApiCalls++;

        if (res.items.length === 0) break;

        for (const item of res.items) {
          progress.totalResults++;
          pageResults++;

          const title = stripHtml(item.title);
          const desc = stripHtml(item.description);
          const combined = `${title} ${desc}`;

          const matched = findMatchingLots(combined, index);

          if (matched.length === 0) {
            progress.unmatchedResults++;
            continue;
          }

          progress.matchedResults++;
          const sentiment = detectSentiment(combined);

          for (const lot of matched) {
            addSignal(lot, item.link, title, desc, sentiment);
            keywordMatches++;
          }
        }

        // 결과가 display보다 적으면 마지막 페이지
        if (res.items.length < RESULTS_PER_PAGE) break;
      } catch (err) {
        console.error(`\n  API 오류: ${(err as Error).message}`);
        break;
      }

      await sleep(DELAY);
    }

    console.log(` → ${pageResults}건, 매칭 ${keywordMatches}건`);

    completedSet.add(keyword);
    progress.completedKeywords.push(keyword);

    if (keywordIdx % 5 === 0) {
      saveProgress(PROGRESS_JSON, progress);
    }

    await sleep(DELAY);
  }

  saveProgress(PROGRESS_JSON, progress);

  // --- 결과 출력 ---
  const outputPath = resolve(import.meta.dir, "cafe-signals.json");
  const { writeFileSync } = await import("fs");
  writeFileSync(outputPath, JSON.stringify(signals, null, 2));

  // 주차장별 집계 (통계용)
  const lotStats = new Map<string, { name: string; count: number }>();
  for (const s of signals) {
    const stat = lotStats.get(s.parkingLotId) ?? { name: s.lotName, count: 0 };
    stat.count++;
    lotStats.set(s.parkingLotId, stat);
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`✅ Phase 1 완료!`);
  console.log(`  API 호출: ${progress.totalApiCalls}회`);
  console.log(`  검색 결과: ${progress.totalResults}건`);
  console.log(`  매칭된 결과: ${progress.matchedResults}건 (${progress.totalResults > 0 ? ((progress.matchedResults / progress.totalResults) * 100).toFixed(1) : 0}%)`);
  console.log(`  개별 시그널: ${signals.length}건`);
  console.log(`  고유 주차장: ${lotStats.size}개`);
  console.log(`  결과 파일: ${outputPath}`);

  // Top 20 출력
  const topLots = [...lotStats.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 20);
  console.log(`\n📊 Top 20 — 시그널 많은 주차장:`);
  console.log(`${"─".repeat(60)}`);
  for (const [, stat] of topLots) {
    console.log(`  ${stat.count}건 | ${stat.name}`);
  }
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
