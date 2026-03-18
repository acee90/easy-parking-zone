/**
 * POI 분석 결과 → DB 적재 (배치 방식)
 *
 * 1. DB 주차장 전체 조회 (1회)
 * 2. POI 좌표 근처 주차장 매칭 (메모리)
 * 3. 매칭 실패 시 카카오 키워드 검색으로 geocoding (1차 fallback)
 * 4. geocoding 실패 시 poi_unmatched 테이블 적재 (2차 fallback → admin 확인)
 * 5. SQL 파일 생성 후 일괄 실행 (1회)
 *
 * 사용법: bun run scripts/load-poi-to-db.ts [--remote] [--input=파일명]
 */
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import { d1Query, d1ExecFile, isRemote } from "./lib/d1";
import { sleep } from "./lib/geo";

const KAKAO_API_KEY = process.env.KAKAO_REST_API_KEY;

const DIR = resolve(import.meta.dir);
const inputArg = process.argv.find((a) => a.startsWith("--input="))?.split("=")[1];
const ANALYSIS_FILE = resolve(DIR, inputArg ?? "poi-analysis-result.json");
const contentName = inputArg ? inputArg.replace("poi-analysis-", "poi-content-") : "poi-content-result.json";
const CONTENT_FILE = resolve(DIR, contentName);
const suffix = inputArg ? inputArg.replace("poi-analysis-", "").replace(".json", "") : "";
const MATCH_REPORT = resolve(DIR, suffix ? `poi-match-report-${suffix}.json` : "poi-match-report.json");
const SQL_FILE = resolve(DIR, suffix ? `poi-load-batch-${suffix}.sql` : "poi-load-batch.sql");

const SEARCH_RADIUS_DEG = 0.005; // ~500m
const MIN_NAME_SIMILARITY = 0.5; // 0.4 → 0.5 상향 (오매칭 방지)
const GEOCODING_MIN_SIMILARITY = 0.3; // geocoding 결과 이름 검증 임계값
const KAKAO_DELAY = 100;

// --- 브랜드 사전 ---
const BRANDS = [
  "롯데", "신세계", "현대", "이마트", "홈플러스", "코스트코", "트레이더스",
  "갤러리아", "AK", "NC", "하이파킹", "카카오",
];

// --- 주차장 접미사 정규화 ---
const PARKING_SUFFIXES = /\s*(지하|지상|제\d+|별관|본관|민영|공영|노외|노상)?\s*주차장$/;

function normalizeParkingName(name: string): string {
  return name.replace(PARKING_SUFFIXES, " 주차장").replace(/\s+/g, " ").trim();
}

// --- 브랜드 추출 ---
function extractBrand(name: string): string | null {
  for (const brand of BRANDS) {
    if (name.includes(brand)) return brand;
  }
  return null;
}

// --- 이름 유사도 (토큰 기반 + 브랜드 검증) ---
function tokenize(name: string): Set<string> {
  return new Set(
    name
      .toLowerCase()
      .replace(/[^\w가-힣]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

function nameSimilarity(a: string, b: string): number {
  // 1. 브랜드 불일치 페널티
  const brandA = extractBrand(a);
  const brandB = extractBrand(b);
  if (brandA && brandB && brandA !== brandB) return 0; // 브랜드가 다르면 즉시 0

  // 2. 정규화 후 토큰 비교
  const normA = normalizeParkingName(a);
  const normB = normalizeParkingName(b);
  const tokensA = tokenize(normA);
  const tokensB = tokenize(normB);
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersect = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersect++;
  const jaccard = intersect / (tokensA.size + tokensB.size - intersect);
  const containsBonus = normA.includes(normB) || normB.includes(normA) ? 0.3 : 0;
  return Math.min(1, jaccard + containsBonus);
}

function escapeSql(s: string): string {
  return s.replace(/'/g, "''");
}

// --- Types ---
interface AnalysisPoi {
  poiName: string;
  address: string;
  lat: number;
  lng: number;
  kakaoId: string;
  categoryLabel: string;
  parkingLots: { name: string; fee?: string; freeCondition?: string; tips?: string[] }[];
  generalTips: string[];
  difficulty: string;
  summary: string;
}

interface DbLot {
  id: string;
  name: string;
  lat: number;
  lng: number;
  poi_tags: string | null;
}

interface MatchResult {
  poiName: string;
  extractedName: string;
  dbLotId: string;
  dbLotName: string;
  similarity: number;
  matchType: "name" | "geocoding-existing" | "geocoding-new";
}

// --- 카카오 키워드 검색 (geocoding fallback) ---
interface KakaoKeywordResult {
  id: string;
  place_name: string;
  address_name: string;
  road_address_name: string;
  x: string; // lng
  y: string; // lat
  phone: string;
  category_name: string;
}

async function kakaoKeywordSearch(
  query: string,
  lat: number,
  lng: number,
): Promise<KakaoKeywordResult | null> {
  if (!KAKAO_API_KEY) return null;

  const params = new URLSearchParams({
    query,
    x: String(lng),
    y: String(lat),
    radius: "2000", // 2km
    size: "5",
    sort: "accuracy",
  });

  try {
    const res = await fetch(
      `https://dapi.kakao.com/v2/local/search/keyword.json?${params}`,
      { headers: { Authorization: `KakaoAK ${KAKAO_API_KEY}` } },
    );
    if (!res.ok) return null;

    const data = await res.json() as { documents: KakaoKeywordResult[] };
    if (data.documents.length === 0) return null;

    // 주차장 카테고리 결과만 반환 (비주차장 결과 무시)
    return data.documents.find((d) => d.category_name.includes("주차장")) ?? null;
  } catch {
    return null;
  }
}

function inferType(categoryName: string, placeName: string): string {
  const cat = categoryName + placeName;
  if (cat.includes("노상")) return "노상";
  if (cat.includes("노외")) return "노외";
  if (cat.includes("부설") || cat.includes("건물")) return "부설";
  if (cat.includes("공영") || cat.includes("공용")) return "노외";
  if (cat.includes("기계식")) return "부설";
  return "노외";
}

// --- 주차장 이름인지 간단 필터 ---
function looksLikeParkingLot(name: string): boolean {
  const keywords = ["주차", "파킹", "parking", "공영", "노외", "노상"];
  const lower = name.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

// --- 음식점/카페/아파트 필터 ---
const NON_PARKING_PATTERNS = [
  /카페|커피|coffee/i,
  /식당|레스토랑|맛집|음식점|푸드/i,
  /양꼬치|샤브|치킨|피자|버거|타코|비스트로|호호식당/i,
  /아파트|오피스텔|빌라|주택|캐슬|프렌즈|와이시티|레우스/i,
  /메가박스|CGV|롯데시네마/i,
];

function looksLikeNonParking(name: string): boolean {
  return NON_PARKING_PATTERNS.some((p) => p.test(name));
}

// --- 메인 ---
async function main() {
  console.log(`=== POI → DB 적재 (${isRemote ? "REMOTE" : "LOCAL"}) ===\n`);

  if (!KAKAO_API_KEY) {
    console.log("⚠️  KAKAO_REST_API_KEY 미설정 → geocoding fallback 비활성화\n");
  }

  const analysis = JSON.parse(readFileSync(ANALYSIS_FILE, "utf-8"));
  const content = JSON.parse(readFileSync(CONTENT_FILE, "utf-8"));
  const pois: AnalysisPoi[] = analysis.results;

  // Phase 1: 전체 주차장 한 번에 조회
  console.log("📦 DB 주차장 전체 조회...");
  const allLots = d1Query<DbLot>(
    `SELECT id, name, lat, lng, poi_tags FROM parking_lots`,
  );
  console.log(`  → ${allLots.length}건 로드\n`);

  // 기존 web_sources source_url 조회 (중복 방지)
  console.log("📦 기존 POI 리뷰 조회...");
  const existingReviews = d1Query<{ parking_lot_id: string; source_url: string }>(
    `SELECT parking_lot_id, source_url FROM web_sources WHERE source = 'poi'`,
  );
  const existingUrlSet = new Set(existingReviews.map((r) => `${r.parking_lot_id}|${r.source_url}`));
  console.log(`  → 기존 ${existingReviews.length}건\n`);

  // 기존 poi_unmatched 조회 (중복 방지)
  const existingUnmatched = d1Query<{ poi_name: string; lot_name: string }>(
    `SELECT poi_name, lot_name FROM poi_unmatched`,
  );
  const existingUnmatchedSet = new Set(existingUnmatched.map((r) => `${r.poi_name}|${r.lot_name}`));

  const allMatches: MatchResult[] = [];
  const unmatchedLots: { poiName: string; lotName: string; reason: string }[] = [];
  const geocodedLots: { poiName: string; lotName: string; kakaoId: string; kakaoName: string }[] = [];
  const skippedNonParking: { poiName: string; name: string }[] = [];
  const sqlStatements: string[] = [];
  let totalTagsUpdated = 0;
  let totalReviewsInserted = 0;
  let totalGeocoded = 0;
  let totalUnmatchedInserted = 0;

  for (let i = 0; i < pois.length; i++) {
    const poi = pois[i];
    console.log(`[${i + 1}/${pois.length}] 📍 ${poi.poiName}`);

    // 1. 좌표 근처 주차장 필터 (메모리)
    const nearbyLots = allLots.filter(
      (l) =>
        Math.abs(l.lat - poi.lat) <= SEARCH_RADIUS_DEG &&
        Math.abs(l.lng - poi.lng) <= SEARCH_RADIUS_DEG,
    );

    console.log(`  근처 DB 주차장: ${nearbyLots.length}건`);

    // 2. AI 추출 주차장 ↔ DB 주차장 매칭
    const matchedDbIds = new Set<string>();

    for (const extracted of poi.parkingLots) {
      // 비주차장 필터 (음식점/카페/아파트)
      if (looksLikeNonParking(extracted.name)) {
        skippedNonParking.push({ poiName: poi.poiName, name: extracted.name });
        console.log(`  🚫 "${extracted.name}" → 비주차장 (스킵)`);
        continue;
      }

      let bestMatch: { lot: DbLot; sim: number } | null = null;

      for (const dbLot of nearbyLots) {
        const sim = nameSimilarity(extracted.name, dbLot.name);
        if (sim >= MIN_NAME_SIMILARITY && (!bestMatch || sim > bestMatch.sim)) {
          bestMatch = { lot: dbLot, sim };
        }
      }

      if (bestMatch) {
        allMatches.push({
          poiName: poi.poiName,
          extractedName: extracted.name,
          dbLotId: bestMatch.lot.id,
          dbLotName: bestMatch.lot.name,
          similarity: bestMatch.sim,
          matchType: "name",
        });
        matchedDbIds.add(bestMatch.lot.id);
        console.log(
          `  ✅ "${extracted.name}" → "${bestMatch.lot.name}" (${(bestMatch.sim * 100).toFixed(0)}%)`,
        );
      } else if (looksLikeParkingLot(extracted.name) && KAKAO_API_KEY) {
        // 1차 fallback: 카카오 키워드 검색으로 geocoding
        const result = await kakaoKeywordSearch(extracted.name, poi.lat, poi.lng);
        await sleep(KAKAO_DELAY);

        if (result) {
          // geocoding 결과 이름 검증 — 이름이 너무 다르면 거부
          const geoSim = nameSimilarity(extracted.name, result.place_name);
          if (geoSim < GEOCODING_MIN_SIMILARITY) {
            unmatchedLots.push({ poiName: poi.poiName, lotName: extracted.name, reason: `geocoding 이름 불일치: "${result.place_name}" (${(geoSim * 100).toFixed(0)}%)` });
            const key = `${poi.poiName}|${extracted.name}`;
            if (!existingUnmatchedSet.has(key)) {
              sqlStatements.push(
                `INSERT OR IGNORE INTO poi_unmatched (poi_name, lot_name, poi_lat, poi_lng, category) VALUES ('${escapeSql(poi.poiName)}', '${escapeSql(extracted.name)}', ${poi.lat}, ${poi.lng}, '${escapeSql(poi.categoryLabel ?? "")}');`,
              );
              existingUnmatchedSet.add(key);
              totalUnmatchedInserted++;
            }
            console.log(`  ⚠️ "${extracted.name}" → geocoding "${result.place_name}" 불일치 (${(geoSim * 100).toFixed(0)}%) → admin`);
            continue;
          }

          const newId = `KA-${result.id}`;
          // 이미 allLots에 있는지 확인
          const existing = allLots.find((l) => l.id === newId);
          if (existing) {
            // 이미 DB에 있지만 근처로 안 잡혔던 경우
            allMatches.push({
              poiName: poi.poiName,
              extractedName: extracted.name,
              dbLotId: existing.id,
              dbLotName: existing.name,
              similarity: geoSim,
              matchType: "geocoding-existing",
            });
            matchedDbIds.add(existing.id);
            console.log(
              `  🔍 "${extracted.name}" → 기존 "${existing.name}" (geocoding ${(geoSim * 100).toFixed(0)}%)`,
            );
          } else {
            // 새 주차장 INSERT
            const lat = parseFloat(result.y);
            const lng = parseFloat(result.x);
            const name = escapeSql(result.place_name);
            const address = escapeSql(result.road_address_name || result.address_name || "");
            const phone = escapeSql(result.phone || "");
            const type = inferType(result.category_name, result.place_name);

            sqlStatements.push(
              `INSERT OR IGNORE INTO parking_lots (id,name,type,address,lat,lng,total_spaces,is_free,phone) VALUES ('${newId}','${name}','${type}','${address}',${lat},${lng},0,0,'${phone}');`,
            );

            // allLots에도 추가 (이후 POI에서 재사용)
            const newLot: DbLot = { id: newId, name: result.place_name, lat, lng, poi_tags: null };
            allLots.push(newLot);
            nearbyLots.push(newLot);
            matchedDbIds.add(newId);

            geocodedLots.push({
              poiName: poi.poiName,
              lotName: extracted.name,
              kakaoId: result.id,
              kakaoName: result.place_name,
            });
            totalGeocoded++;
            console.log(
              `  🆕 "${extracted.name}" → 신규등록 "${result.place_name}" (geocoding ${(geoSim * 100).toFixed(0)}%)`,
            );
          }
        } else {
          // 2차 fallback: poi_unmatched에 적재
          unmatchedLots.push({ poiName: poi.poiName, lotName: extracted.name, reason: "geocoding 결과 없음" });
          const key = `${poi.poiName}|${extracted.name}`;
          if (!existingUnmatchedSet.has(key)) {
            sqlStatements.push(
              `INSERT OR IGNORE INTO poi_unmatched (poi_name, lot_name, poi_lat, poi_lng, category) VALUES ('${escapeSql(poi.poiName)}', '${escapeSql(extracted.name)}', ${poi.lat}, ${poi.lng}, '${escapeSql(poi.categoryLabel ?? "")}');`,
            );
            existingUnmatchedSet.add(key);
            totalUnmatchedInserted++;
          }
          console.log(`  ❌ "${extracted.name}" → 매칭 없음 (→ admin)`);
        }
      } else {
        // 주차장 이름이 아닌 경우 또는 API key 없는 경우
        unmatchedLots.push({ poiName: poi.poiName, lotName: extracted.name, reason: looksLikeParkingLot(extracted.name) ? "이름 매칭 실패" : "비주차장 이름" });
        if (looksLikeParkingLot(extracted.name)) {
          const key = `${poi.poiName}|${extracted.name}`;
          if (!existingUnmatchedSet.has(key)) {
            sqlStatements.push(
              `INSERT OR IGNORE INTO poi_unmatched (poi_name, lot_name, poi_lat, poi_lng, category) VALUES ('${escapeSql(poi.poiName)}', '${escapeSql(extracted.name)}', ${poi.lat}, ${poi.lng}, '${escapeSql(poi.categoryLabel ?? "")}');`,
            );
            existingUnmatchedSet.add(key);
            totalUnmatchedInserted++;
          }
        }
        console.log(`  ❌ "${extracted.name}" → 매칭 없음`);
      }
    }

    // 3. 근처 주차장 전체에 POI 태그 부여
    const tagTargetIds = new Set(matchedDbIds);
    for (const dbLot of nearbyLots) {
      tagTargetIds.add(dbLot.id);
    }

    for (const dbId of tagTargetIds) {
      const lot = nearbyLots.find((l) => l.id === dbId) ?? allLots.find((l) => l.id === dbId);
      let currentTags: string[] = [];
      try {
        if (lot?.poi_tags) currentTags = JSON.parse(lot.poi_tags) ?? [];
      } catch { /* ignore parse error */ }

      if (!currentTags.includes(poi.poiName)) {
        currentTags.push(poi.poiName);
        // lot 객체의 poi_tags도 업데이트 (같은 lot이 여러 POI에 매칭될 수 있음)
        if (lot) lot.poi_tags = JSON.stringify(currentTags);
        const tagsJson = escapeSql(JSON.stringify(currentTags));
        sqlStatements.push(
          `UPDATE parking_lots SET poi_tags = '${tagsJson}' WHERE id = '${dbId}';`,
        );
        totalTagsUpdated++;
      }
    }

    // 4. web_sources INSERT SQL 생성 — 이름 매칭된 주차장에만 삽입
    const poiContent = content.results.find((r: any) => r.name === poi.poiName);
    if (!poiContent || matchedDbIds.size === 0) continue;

    const matchedLots = [...matchedDbIds].map((id) => nearbyLots.find((l) => l.id === id) ?? allLots.find((l) => l.id === id)).filter(Boolean) as DbLot[];
    let inserted = 0;
    for (const lot of matchedLots) {
      for (const post of poiContent.posts) {
        const key = `${lot.id}|${post.link}`;
        if (existingUrlSet.has(key)) continue;

        const title = escapeSql(post.title);
        const snippet = escapeSql(post.snippet);
        const link = escapeSql(post.link);
        // source_id: lot별 유니크 — lot.id 해시를 suffix로 추가
        const lotSuffix = Buffer.from(lot.id).toString("base64url").slice(0, 8);
        const sourceId = escapeSql(`poi_${Buffer.from(post.link).toString("base64url").slice(0, 56)}_${lotSuffix}`);

        sqlStatements.push(
          `INSERT OR IGNORE INTO web_sources (parking_lot_id, source, source_id, source_url, title, content, relevance_score) VALUES ('${lot.id}', 'poi', '${sourceId}', '${link}', '${title}', '${snippet}', 60);`,
        );
        existingUrlSet.add(key);
        inserted++;
      }
    }
    totalReviewsInserted += inserted;
    if (inserted > 0) {
      console.log(`  📝 리뷰 ${inserted}건 → ${matchedLots.map((l) => l.name).join(", ")}`);
    }
  }

  // Phase 2: SQL 파일 저장 + 일괄 실행
  console.log(`\n📄 SQL 파일 생성: ${sqlStatements.length}건`);
  writeFileSync(SQL_FILE, sqlStatements.join("\n"));

  if (sqlStatements.length > 0) {
    console.log("🚀 DB 일괄 실행...");
    d1ExecFile(SQL_FILE);
    console.log("✅ 완료!");
  }

  // 리포트 저장
  const report = {
    meta: {
      createdAt: new Date().toISOString(),
      remote: isRemote,
      totalPois: pois.length,
      totalMatches: allMatches.length,
      totalGeocoded: geocodedLots.length,
      totalUnmatched: unmatchedLots.length,
      totalUnmatchedInserted: totalUnmatchedInserted,
      totalSkippedNonParking: skippedNonParking.length,
      totalTagsUpdated,
      totalReviewsInserted,
    },
    matches: allMatches,
    geocoded: geocodedLots,
    unmatched: unmatchedLots,
    skippedNonParking,
  };
  writeFileSync(MATCH_REPORT, JSON.stringify(report, null, 2));

  // 요약
  console.log("\n" + "=".repeat(50));
  console.log("📋 적재 요약");
  console.log("=".repeat(50));
  console.log(`총 POI: ${pois.length}건`);
  console.log(`이름 매칭 성공: ${allMatches.length}건`);
  console.log(`🆕 geocoding 신규등록: ${totalGeocoded}건`);
  console.log(`🚫 비주차장 스킵: ${skippedNonParking.length}건`);
  console.log(`❌ 매칭 실패: ${unmatchedLots.length}건 (admin 적재: ${totalUnmatchedInserted}건)`);
  console.log(`poi_tags 업데이트: ${totalTagsUpdated}건`);
  console.log(`web_sources 적재: ${totalReviewsInserted}건`);
  console.log(`\n📄 매칭 리포트: ${MATCH_REPORT}`);
}

main().catch((e) => {
  console.error("오류 발생:", e);
  process.exit(1);
});
