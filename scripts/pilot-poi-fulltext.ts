/**
 * POI 파일럿: 블로그/카페 원문 수집 + 주차장 매칭 테스트
 *
 * 1. 샘플 POI web_sources에서 URL 추출
 * 2. 네이버 블로그/카페 원문 HTML fetch → 본문 텍스트 추출
 * 3. 본문에서 DB 주차장명 키워드 검색 (매칭)
 * 4. 기존 매칭(parking_lot_id)과 비교 리포트
 *
 * 사용법:
 *   bun run scripts/pilot-poi-fulltext.ts
 *   bun run scripts/pilot-poi-fulltext.ts --remote   # remote DB에서 샘플 로드
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import { d1Query, isRemote } from "./lib/d1";
import { sleep } from "./lib/geo";

const DIR = resolve(import.meta.dir);
const SAMPLE_FILE = resolve(DIR, "pilot-fulltext-sample.json");
const RESULT_FILE = resolve(DIR, "pilot-fulltext-result-v2.json");
const FETCH_DELAY = 500; // ms between requests

// ─── 타입 ──────────────────────────────────────────────
interface SampleRow {
  id: number;
  title: string;
  content: string; // snippet
  source_url: string;
  parking_lot_id: string;
  lot_name: string;
  lot_address: string;
  lot_lat: number;
  lot_lng: number;
}

interface FetchResult {
  id: number;
  sourceUrl: string;
  currentLotId: string;
  currentLotName: string;
  fullText: string | null;
  fullTextLength: number;
  fetchError: string | null;
  matches: MatchResult[];
}

interface MatchResult {
  lotId: string;
  lotName: string;
  matchedKeywords: string[];
  keywordCount: number;
  contextSnippet: string; // 매칭 지점 ±100자
}

// ─── DB 주차장 로드 ──────────────────────────────────────
interface ParkingLot {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
}

interface LotKeywords {
  lot: ParkingLot;
  keywords: string[];       // 고유 키워드 (매칭용)
  fullName: string;         // 정규화된 전체 이름
}

/** 단독 매칭 금지 일반명사 — 전국에 흔한 시설명 */
const GENERIC_NOUNS = new Set([
  "이마트", "홈플러스", "코스트코", "롯데마트", "하나로마트",
  "박물관", "도서관", "체육관", "경기장", "테니스장", "수영장",
  "어린이집", "유치원", "초등학교", "중학교", "고등학교",
  "아파트", "빌딩", "오피스텔", "주민센터", "보건소",
  "시장", "마을", "공원", "센터", "회관",
  "병원", "의원", "약국", "교회", "성당", "절",
  "서울특별시", "서울시", "부산광역시", "대구광역시", "인천광역시",
  "광주", "대전", "울산", "세종", "경기도",
]);

/** 주차장명에서 검색용 키워드 추출 */
function extractKeywords(name: string): string[] {
  const cleaned = name
    .replace(/주차장|공영|노외|노상|부설|제\d+|지하|지상|별관|본관|민영|\d+면/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(/\s+/).filter((w) => w.length >= 2);
  return words;
}

/** 키워드가 일반명사인지 (단독 매칭 금지 대상) */
function isGenericKeyword(kw: string): boolean {
  return GENERIC_NOUNS.has(kw);
}

/** Haversine 거리 (km) */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ─── 네이버 블로그/카페 본문 추출 ─────────────────────────
/** 네이버 블로그 iframe URL → 실제 본문 URL 변환 */
function toBlogContentUrl(url: string): string {
  // blog.naver.com/userId/postId → blog.naver.com/PostView.naver?blogId=userId&logNo=postId
  const match = url.match(/blog\.naver\.com\/([^/]+)\/(\d+)/);
  if (match) {
    return `https://blog.naver.com/PostView.naver?blogId=${match[1]}&logNo=${match[2]}&directAccess=false`;
  }
  return url;
}

/** 카페 URL → 모바일 URL (더 쉽게 파싱) */
function toCafeMobileUrl(url: string): string {
  // cafe.naver.com/cafeName/articleId → m.cafe.naver.com/ca-fe/web/cafes/.../articles/...
  const match = url.match(/cafe\.naver\.com\/([^/]+)\/(\d+)/);
  if (match) {
    return `https://m.cafe.naver.com/ca-fe/web/cafes/${match[1]}/articles/${match[2]}`;
  }
  return url;
}

/** HTML에서 텍스트 추출 (태그 제거 + 정리) */
function htmlToText(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/** 네이버 블로그 본문 fetch */
async function fetchBlogFullText(url: string): Promise<string> {
  const contentUrl = toBlogContentUrl(url);
  const res = await fetch(contentUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();

  // 네이버 블로그: se-main-container 시작부터 끝까지 (greedy)
  const containerStart = html.indexOf('class="se-main-container"');
  if (containerStart !== -1) {
    // container 시작 ~ 다음 </main> 또는 class="comment" 또는 footer까지
    const afterContainer = html.slice(containerStart);
    const endMarkers = [
      afterContainer.indexOf('class="se-viewer-footer"'),
      afterContainer.indexOf('class="comment'),
      afterContainer.indexOf('</main>'),
      afterContainer.indexOf('id="printPost1"'),
    ].filter((i) => i > 0);
    const endIdx = endMarkers.length > 0 ? Math.min(...endMarkers) : afterContainer.length;
    return htmlToText(afterContainer.slice(0, endIdx));
  }

  // 구형 에디터: post-view
  const postViewStart = html.indexOf('id="post-view');
  if (postViewStart !== -1) {
    const afterView = html.slice(postViewStart);
    const endIdx = afterView.indexOf('class="comment');
    return htmlToText(afterView.slice(0, endIdx > 0 ? endIdx : afterView.length));
  }

  // fallback: 전체 body에서 추출
  const bodyMatch = html.match(/<body[\s\S]*<\/body>/i);
  return htmlToText(bodyMatch?.[0] ?? html);
}

/** 네이버 카페 본문 fetch */
async function fetchCafeFullText(url: string): Promise<string> {
  // 카페는 API로 접근 시도
  const match = url.match(/cafe\.naver\.com\/([^/]+)\/(\d+)/);
  if (!match) throw new Error("카페 URL 파싱 실패");

  // 모바일 페이지 시도
  const mobileUrl = toCafeMobileUrl(url);
  const res = await fetch(mobileUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15",
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const html = await res.text();
  const bodyMatch = html.match(/<body[\s\S]*<\/body>/i);
  return htmlToText(bodyMatch?.[0] ?? html);
}

/** URL에서 원문 추출 */
async function fetchFullText(url: string): Promise<string> {
  if (url.includes("cafe.naver.com")) {
    return fetchCafeFullText(url);
  }
  return fetchBlogFullText(url);
}

// ─── 매칭 로직 ──────────────────────────────────────────

const NEARBY_RADIUS_KM = 5; // POI 기준 반경 5km 이내만 매칭 후보

/**
 * 본문에서 주차장 키워드 검색 → 매칭 결과
 *
 * 개선점 (v2):
 * 1. 지역 제한: POI 좌표 기준 5km 이내 주차장만 후보
 * 2. 일반명사 필터: "이마트", "박물관" 등 단독 매칭 금지
 * 3. POI명 활용: POI 이름이 주차장명에 포함되면 보너스
 */
function matchParkingLots(
  fullText: string,
  nearbyLots: LotKeywords[],  // 이미 지역 필터된 후보
  poiName?: string,
): MatchResult[] {
  const textLower = fullText.toLowerCase();
  const results: MatchResult[] = [];

  for (const { lot, keywords } of nearbyLots) {
    if (keywords.length === 0) continue;

    const matched = keywords.filter((kw) => textLower.includes(kw.toLowerCase()));
    if (matched.length === 0) continue;

    // 고유 키워드만 필터 (일반명사 제외)
    const specificMatched = matched.filter((kw) => !isGenericKeyword(kw));

    // 매칭 판정 기준:
    // A) 고유 키워드 2개 이상 → 확정
    // B) 고유 키워드 1개 (3자 이상) → 확정
    // C) 고유 키워드 1개 (2자) + 일반명사 1개 이상 → 확정
    // D) 일반명사만 매칭 → 거부
    // E) 고유 키워드 없고 매칭 1개 → 거부
    let accepted = false;
    if (specificMatched.length >= 2) {
      accepted = true; // A
    } else if (specificMatched.length === 1 && specificMatched[0].length >= 3) {
      accepted = true; // B
    } else if (specificMatched.length === 1 && matched.length >= 2) {
      accepted = true; // C
    }
    // 추가: POI명이 주차장명에 포함된 경우 보너스
    if (!accepted && poiName) {
      const poiLower = poiName.toLowerCase().replace(/주차장|공영/g, "").trim();
      const lotLower = lot.name.toLowerCase();
      if (poiLower.length >= 3 && lotLower.includes(poiLower)) {
        accepted = true; // POI명 직접 포함
      }
    }

    if (!accepted) continue;

    // 첫 번째 고유 키워드 (없으면 첫 매칭) 주변 컨텍스트 추출
    const bestKw = (specificMatched[0] ?? matched[0]).toLowerCase();
    const idx = textLower.indexOf(bestKw);
    const start = Math.max(0, idx - 100);
    const end = Math.min(fullText.length, idx + bestKw.length + 100);
    const contextSnippet = fullText.slice(start, end).replace(/\n/g, " ");

    results.push({
      lotId: lot.id,
      lotName: lot.name,
      matchedKeywords: matched,
      keywordCount: matched.length,
      contextSnippet,
    });
  }

  // 키워드 매칭 수 내림차순
  results.sort((a, b) => b.keywordCount - a.keywordCount);
  return results;
}

// ─── 메인 ───────────────────────────────────────────────
async function main() {
  console.log(`[Pilot] POI 원문 수집 + 매칭 파일럿`);
  console.log(`[Pilot] ${isRemote ? "REMOTE" : "LOCAL"} DB\n`);

  // 1. 샘플 로드 (캐시 또는 DB)
  // v2: 기존 캐시 무시하고 좌표 포함 샘플 새로 로드
  const SAMPLE_V2 = resolve(DIR, "pilot-fulltext-sample-v2.json");
  let samples: SampleRow[];
  if (existsSync(SAMPLE_V2)) {
    samples = JSON.parse(readFileSync(SAMPLE_V2, "utf-8"));
    console.log(`[Pilot] v2 샘플 캐시 로드: ${samples.length}건`);
  } else {
    console.log("[Pilot] DB에서 v2 샘플 추출 중...");
    samples = d1Query<SampleRow>(`
      SELECT ws.id, ws.title, ws.content, ws.source_url, ws.parking_lot_id,
             p.name as lot_name, p.address as lot_address, p.lat as lot_lat, p.lng as lot_lng
      FROM web_sources ws
      JOIN parking_lots p ON p.id = ws.parking_lot_id
      WHERE ws.source = 'poi' AND ws.is_ad = 0
        AND ws.title LIKE '%주차%'
      ORDER BY RANDOM()
      LIMIT 80
    `);
    writeFileSync(SAMPLE_V2, JSON.stringify(samples, null, 2), "utf-8");
    console.log(`[Pilot] ${samples.length}건 샘플 저장 → ${SAMPLE_V2}`);
  }

  // URL 중복 제거
  const uniqueUrls = new Map<string, SampleRow>();
  for (const s of samples) {
    if (!uniqueUrls.has(s.source_url)) uniqueUrls.set(s.source_url, s);
  }
  const uniqueSamples = [...uniqueUrls.values()];
  console.log(`[Pilot] 고유 URL: ${uniqueSamples.length}건\n`);

  // 2. DB 주차장 전체 로드 (매칭용)
  console.log("[Pilot] DB 주차장 로드 중...");
  const allDbLots = d1Query<ParkingLot>(
    "SELECT id, name, address, lat, lng FROM parking_lots",
  );
  const allLotKeywords: LotKeywords[] = allDbLots.map((lot) => ({
    lot,
    keywords: extractKeywords(lot.name),
    fullName: lot.name.toLowerCase(),
  }));
  console.log(`[Pilot] ${allDbLots.length}개 주차장, 키워드 생성 완료\n`);

  // 3. 원문 수집 + 매칭
  const results: FetchResult[] = [];
  let fetchOk = 0;
  let fetchFail = 0;

  for (let i = 0; i < uniqueSamples.length; i++) {
    const sample = uniqueSamples[i];
    process.stdout.write(`\r[Pilot] ${i + 1}/${uniqueSamples.length} fetching...`);

    let fullText: string | null = null;
    let fetchError: string | null = null;

    try {
      fullText = await fetchFullText(sample.source_url);
      fetchOk++;
    } catch (err) {
      fetchError = (err as Error).message;
      fetchFail++;
    }
    await sleep(FETCH_DELAY);

    // v2: POI 좌표 기준 반경 5km 이내 주차장만 후보
    const nearbyLots = allLotKeywords.filter((lk) =>
      haversineKm(sample.lot_lat, sample.lot_lng, lk.lot.lat, lk.lot.lng) <= NEARBY_RADIUS_KM
    );

    // POI명 추정: 제목에서 "주차" 앞부분 추출, 없으면 lot_name 기반
    const poiName = sample.title.replace(/\s*주차.*$/, "").trim() || undefined;

    const matches = fullText
      ? matchParkingLots(fullText, nearbyLots, poiName)
      : [];

    results.push({
      id: sample.id,
      sourceUrl: sample.source_url,
      currentLotId: sample.parking_lot_id,
      currentLotName: sample.lot_name,
      fullText: fullText ? fullText.slice(0, 3000) : null, // 저장 크기 제한
      fullTextLength: fullText?.length ?? 0,
      fetchError,
      matches,
      nearbyCount: nearbyLots.length,
    } as FetchResult);

    await sleep(FETCH_DELAY);
  }

  console.log(`\n\n[Pilot] === 수집 결과 ===`);
  console.log(`  성공: ${fetchOk}, 실패: ${fetchFail}`);

  // 4. 매칭 비교 리포트
  let correctMatch = 0;    // 새 매칭에 기존 lot이 포함됨
  let newMatches = 0;       // 새로 발견된 추가 주차장
  let noMatch = 0;          // 아무것도 매칭 안됨
  let lostMatch = 0;        // 기존 매칭이 새 매칭에 없음

  for (const r of results) {
    if (!r.fullText) continue;

    const newLotIds = new Set(r.matches.map((m) => m.lotId));
    const hasCurrentLot = newLotIds.has(r.currentLotId);

    if (r.matches.length === 0) {
      noMatch++;
    } else if (hasCurrentLot) {
      correctMatch++;
      if (r.matches.length > 1) newMatches += r.matches.length - 1;
    } else {
      lostMatch++;
    }
  }

  const fetched = results.filter((r) => r.fullText);
  console.log(`\n[Pilot] === 매칭 비교 (${fetched.length}건) ===`);
  console.log(`  기존 매칭 유지: ${correctMatch}건`);
  console.log(`  추가 주차장 발견: ${newMatches}건`);
  console.log(`  매칭 없음: ${noMatch}건`);
  console.log(`  기존 매칭 소실: ${lostMatch}건`);

  // 5. 상세 리포트
  console.log(`\n[Pilot] === 상세 리포트 (기존 매칭 소실 + 새 매칭) ===`);
  for (const r of results) {
    if (!r.fullText) continue;
    const newLotIds = new Set(r.matches.map((m) => m.lotId));

    if (!newLotIds.has(r.currentLotId) || r.matches.length > 1) {
      console.log(`\n  URL: ${r.sourceUrl}`);
      console.log(`  기존: ${r.currentLotName} (${r.currentLotId})`);
      if (r.matches.length === 0) {
        console.log(`  새 매칭: 없음`);
      } else {
        for (const m of r.matches.slice(0, 5)) {
          const marker = m.lotId === r.currentLotId ? "✅" : "🆕";
          console.log(`  ${marker} ${m.lotName} (kw: ${m.matchedKeywords.join(",")})`);
          console.log(`     context: "${m.contextSnippet.slice(0, 120)}"`);
        }
      }
    }
  }

  // 저장
  writeFileSync(RESULT_FILE, JSON.stringify(results, null, 2), "utf-8");
  console.log(`\n[Pilot] 결과 저장 → ${RESULT_FILE}`);
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
