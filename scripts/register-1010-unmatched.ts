/**
 * 10시10분 채널 미매칭 주차장 → 네이버 지역검색으로 DB 등록
 *
 * 정확도 우선: 애매한 매칭은 전부 실패 리스트로 빠짐.
 * - 검색 결과에 "주차" 카테고리 필수
 * - 주차장명 핵심 키워드가 검색 결과에 포함되어야 함
 * - 좌표가 한국 범위 내여야 함
 *
 * 사용법: bun run scripts/register-1010-unmatched.ts
 *   --dry-run   DB/파일 수정 없이 미리보기
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";

// --- Config ---
const RESULT_JSON = resolve(import.meta.dir, "1010-parking-result.json");
const HELL_LIST_JSON = resolve(import.meta.dir, "hell-parking-list.json");
const STILL_UNMATCHED_JSON = resolve(import.meta.dir, "1010-still-unmatched.json");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-register.sql");
const DELAY = 250;

const CLIENT_ID = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;

// --- Types ---
interface ParsedParking {
  videoId: string;
  videoTitle: string;
  parkingName: string;
  location: string;
  reason: string;
  isParking: boolean;
}

interface HellListEntry {
  id?: string;
  name: string;
  tag: "hell" | "easy";
  reason: string;
}

interface NaverPlace {
  title: string;
  address: string;
  roadAddress: string;
  mapx: string;
  mapy: string;
  telephone: string;
  category: string;
}

interface ExistingLot {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

interface MatchResult {
  parsed: ParsedParking;
  naverPlace: NaverPlace;
  id: string;
  name: string;
  lat: number;
  lng: number;
  confidence: "high" | "medium";
}

interface FailedEntry {
  parkingName: string;
  location: string;
  reason: string;
  videoTitle: string;
  failReason: string;
}

// --- Helpers ---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function esc(s: string): string {
  return s.replace(/'/g, "''").replace(/<\/?b>/g, "");
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function parseCoords(mapx: string, mapy: string): { lat: number; lng: number } {
  const lng = parseInt(mapx, 10) / 10_000_000;
  const lat = parseInt(mapy, 10) / 10_000_000;
  return { lat, lng };
}

function d1Query<T = Record<string, unknown>>(sql: string): T[] {
  const escaped = sql.replace(/"/g, '\\"');
  const raw = execSync(
    `npx wrangler d1 execute parking-db --local --json --command "${escaped}"`,
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 }
  );
  return JSON.parse(raw)[0]?.results ?? [];
}

// --- 네이버 지역검색 ---
async function searchLocal(query: string): Promise<NaverPlace[]> {
  const params = new URLSearchParams({
    query,
    display: "5",
    start: "1",
    sort: "comment",
  });

  const res = await fetch(`https://openapi.naver.com/v1/search/local.json?${params}`, {
    headers: {
      "X-Naver-Client-Id": CLIENT_ID!,
      "X-Naver-Client-Secret": CLIENT_SECRET!,
    },
  });

  if (!res.ok) {
    if (res.status === 429) {
      console.log("  Rate limited, waiting 10s...");
      await sleep(10000);
      return searchLocal(query);
    }
    throw new Error(`Naver API ${res.status}: ${await res.text()}`);
  }

  await sleep(DELAY);
  const data = (await res.json()) as { items: NaverPlace[] };
  return data.items ?? [];
}

// --- 매칭 검증 (엄격) ---
function extractKeywords(name: string): string[] {
  return name
    .replace(/주차장|주차|지하|지상|빌딩|타워|프라자|호텔|병원|백화점/g, "")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

function validateMatch(
  parsed: ParsedParking,
  place: NaverPlace
): { valid: boolean; confidence: "high" | "medium"; failReason: string } {
  const title = stripHtml(place.title);

  // 1) 카테고리에 "주차" 포함 OR 결과명에 "주차" 포함
  const hasParkingCategory = place.category.includes("주차");
  const hasParkingName = title.includes("주차");
  if (!hasParkingCategory && !hasParkingName) {
    return { valid: false, confidence: "medium", failReason: "주차 카테고리/이름 아님" };
  }

  // 2) 좌표 유효성 (한국 범위)
  if (!place.mapx || !place.mapy) {
    return { valid: false, confidence: "medium", failReason: "좌표 없음" };
  }
  const { lat, lng } = parseCoords(place.mapx, place.mapy);
  if (lat < 33 || lat > 39 || lng < 124 || lng > 132) {
    return { valid: false, confidence: "medium", failReason: "좌표 범위 밖" };
  }

  // 3) 지역 검증 — 원본에 지역 정보가 있으면 주소에 포함되어야 함
  const address = place.roadAddress || place.address || "";
  if (parsed.location && parsed.location !== "미상" && parsed.location !== "미확인" && parsed.location !== "") {
    // 광역시/도 단위 단어는 너무 넓어서 제외 (서울, 부산, 인천, 경기 등)
    const broadRegions = new Set(["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"]);
    const locParts = parsed.location.split(/\s+/).filter((w) => w.length >= 2);
    const narrowParts = locParts.filter((w) => !broadRegions.has(w));

    if (narrowParts.length > 0) {
      // 세부 지역(구/동/도로명)이 있으면 반드시 주소에 포함되어야 함
      const addressHasNarrow = narrowParts.some((part) => address.includes(part));
      if (!addressHasNarrow) {
        return { valid: false, confidence: "medium", failReason: `지역 불일치: "${parsed.location}" → "${narrowParts.join(",")}" not in "${address}"` };
      }
    }
    // narrowParts가 없으면 (광역시/도만 있는 경우) 광역시/도 체크
    else {
      const addressHasBroad = locParts.some((part) => address.includes(part));
      if (!addressHasBroad) {
        return { valid: false, confidence: "medium", failReason: `지역 불일치: "${parsed.location}" vs "${address}"` };
      }
    }
  }

  // 4) 핵심 키워드 매칭 — 원래 이름의 핵심어가 검색 결과에 있어야 함
  const keywords = extractKeywords(parsed.parkingName);
  const titleLower = title.toLowerCase();
  const matchedKeywords = keywords.filter((kw) => titleLower.includes(kw.toLowerCase()));

  if (keywords.length === 0) {
    return { valid: false, confidence: "medium", failReason: "키워드 추출 실패" };
  }

  const matchRatio = matchedKeywords.length / keywords.length;

  if (matchRatio >= 0.8) {
    return { valid: true, confidence: "high", failReason: "" };
  }
  if (matchRatio >= 0.5 && keywords.length <= 2) {
    // 키워드가 1-2개인 짧은 이름은 50% 매칭도 허용하되 medium
    return { valid: true, confidence: "medium", failReason: "" };
  }

  return {
    valid: false,
    confidence: "medium",
    failReason: `키워드 불일치 (${matchedKeywords.join(",")}/${keywords.join(",")})`,
  };
}

// --- 중복 체크 ---
function isDuplicate(existing: ExistingLot[], name: string, lat: number, lng: number): ExistingLot | null {
  return existing.find(
    (lot) =>
      lot.name === name &&
      Math.abs(lot.lat - lat) < 0.002 &&
      Math.abs(lot.lng - lng) < 0.002
  ) ?? null;
}

function isIdExists(existing: ExistingLot[], id: string): boolean {
  return existing.some((lot) => lot.id === id);
}

// --- Main ---
async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET가 .env에 설정되지 않았습니다.");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  // 1) 미매칭 목록 로드
  const allParsed: ParsedParking[] = JSON.parse(readFileSync(RESULT_JSON, "utf-8"));
  const hellList: HellListEntry[] = JSON.parse(readFileSync(HELL_LIST_JSON, "utf-8"));
  const existingHellNames = new Set(
    hellList.map((e) => e.name.replace(/주차장|주차/g, "").trim().toLowerCase())
  );

  // 기존 DB 로드
  console.log("기존 DB 로드 중...");
  const existingLots = d1Query<ExistingLot>("SELECT id, name, lat, lng FROM parking_lots");
  console.log(`  ${existingLots.length}개 로드\n`);

  // collect-1010에서 매칭 성공한 ID 제외 + 기존 hell list 제외
  const existingDbNames = new Set(existingLots.map((l) => l.name.toLowerCase()));
  const unmatchedEntries: ParsedParking[] = [];
  const seenNames = new Set<string>();

  // 사전 제외 목록 (특정 주차장 아님, 해외, 식별 불가)
  const EXCLUDE_NAMES = [
    "미확인", "확인 불가", "불명", "미상",
    "경차 전용 주차장", "오토 발렛 주차장", "신축 주택 자전거 주차장",
    "이스탄불 지하주차장", "이스탄불 기계식 주차장",
    "콜라택 입구가 있는 지하주차장",
  ];
  const excludeSet = new Set(EXCLUDE_NAMES.map((n) => n.toLowerCase()));

  for (const p of allParsed) {
    if (!p.parkingName || !p.isParking) continue;
    if (excludeSet.has(p.parkingName.toLowerCase())) continue;
    const key = p.parkingName.replace(/주차장|주차/g, "").trim().toLowerCase();
    if (!key || seenNames.has(key)) continue;
    if (existingHellNames.has(key)) continue;
    seenNames.add(key);
    unmatchedEntries.push(p);
  }

  // 추가 필터: DB에서 이름 LIKE 매칭되는 것도 제외
  const finalUnmatched: ParsedParking[] = [];
  for (const p of unmatchedEntries) {
    const keywords = extractKeywords(p.parkingName);
    if (keywords.length === 0) continue;
    const conditions = keywords.map((kw) => `name LIKE '%${esc(kw)}%'`).join(" AND ");
    const found = d1Query(`SELECT id FROM parking_lots WHERE ${conditions} LIMIT 1`);
    if (found.length === 0) {
      finalUnmatched.push(p);
    }
  }

  console.log(`=== 네이버 지역검색 등록 시작 ===`);
  console.log(`미매칭 대상: ${finalUnmatched.length}개${dryRun ? " [DRY RUN]" : ""}\n`);

  // 2) 네이버 검색 + 매칭
  const matched: MatchResult[] = [];
  const failed: FailedEntry[] = [];
  const newLots: ExistingLot[] = [];

  for (let i = 0; i < finalUnmatched.length; i++) {
    const p = finalUnmatched[i];
    const num = `[${i + 1}/${finalUnmatched.length}]`;

    // 검색어 구성: "주차장명 주차장" 또는 "주차장명 지역 주차장"
    const queries: string[] = [];
    if (p.location && p.location !== "미상" && p.location !== "미확인") {
      queries.push(`${p.location} ${p.parkingName} 주차장`);
    }
    queries.push(`${p.parkingName} 주차장`);

    let bestMatch: MatchResult | null = null;

    for (const query of queries) {
      try {
        const places = await searchLocal(query);
        for (const place of places) {
          const validation = validateMatch(p, place);
          if (!validation.valid) continue;

          const title = stripHtml(place.title);
          const { lat, lng } = parseCoords(place.mapx, place.mapy);
          const id = `NV-${place.mapx}_${place.mapy}`;

          // 이미 DB에 있으면 스킵
          if (isDuplicate(existingLots, title, lat, lng) || isDuplicate(newLots, title, lat, lng)) continue;
          if (isIdExists(existingLots, id)) continue;

          if (!bestMatch || validation.confidence === "high") {
            bestMatch = { parsed: p, naverPlace: place, id, name: title, lat, lng, confidence: validation.confidence };
            if (validation.confidence === "high") break;
          }
        }
      } catch (err) {
        console.error(`  ${num} API 오류: ${(err as Error).message.slice(0, 60)}`);
      }

      if (bestMatch?.confidence === "high") break;
    }

    if (bestMatch) {
      matched.push(bestMatch);
      newLots.push({ id: bestMatch.id, name: bestMatch.name, lat: bestMatch.lat, lng: bestMatch.lng });
      const conf = bestMatch.confidence === "high" ? "H" : "M";
      console.log(`  ${num} [${conf}] "${p.parkingName}" -> ${bestMatch.name} (${bestMatch.naverPlace.roadAddress || bestMatch.naverPlace.address})`);
    } else {
      failed.push({
        parkingName: p.parkingName,
        location: p.location,
        reason: p.reason,
        videoTitle: p.videoTitle,
        failReason: "네이버 검색 결과 없음 또는 매칭 실패",
      });
      console.log(`  ${num} X "${p.parkingName}" (${p.location}) — 매칭 실패`);
    }
  }

  // 3) 결과 출력
  console.log(`\n=== 결과 ===`);
  console.log(`  매칭 성공: ${matched.length}개 (high: ${matched.filter((m) => m.confidence === "high").length}, medium: ${matched.filter((m) => m.confidence === "medium").length})`);
  console.log(`  매칭 실패: ${failed.length}개`);

  // 4) 실패 리스트 저장 (항상)
  writeFileSync(STILL_UNMATCHED_JSON, JSON.stringify(failed, null, 2));
  console.log(`\n  실패 리스트: ${STILL_UNMATCHED_JSON}`);

  if (matched.length === 0) {
    console.log("\n추가할 항목이 없습니다.");
    return;
  }

  if (dryRun) {
    console.log("\n  [DRY RUN] DB/파일 수정하지 않음");
    console.log("  추가 예정:");
    for (const m of matched) {
      console.log(`    [${m.confidence}] ${m.name} (${m.id}) — ${m.parsed.reason}`);
    }
    return;
  }

  // 5) DB INSERT
  const sqlStatements = matched.map((m) => {
    const p = m.naverPlace;
    const address = esc(p.roadAddress || p.address || "");
    const phone = esc(p.telephone || "");
    return `INSERT OR IGNORE INTO parking_lots (id,name,type,address,lat,lng,total_spaces,is_free,phone) VALUES ('${m.id}','${esc(m.name)}','부설','${address}',${m.lat},${m.lng},0,0,'${phone}');`;
  });

  writeFileSync(TMP_SQL, sqlStatements.join("\n"));
  execSync(`npx wrangler d1 execute parking-db --local --file="${TMP_SQL}"`, { stdio: "pipe" });
  console.log(`\n  DB: ${matched.length}개 주차장 등록`);

  // 6) hell-parking-list.json 업데이트
  const newEntries: HellListEntry[] = matched.map((m) => ({
    id: m.id,
    name: m.name,
    tag: "hell" as const,
    reason: m.parsed.reason,
  }));

  const updatedList = [...hellList, ...newEntries];
  writeFileSync(HELL_LIST_JSON, JSON.stringify(updatedList, null, 2));
  console.log(`  hell-parking-list.json: ${hellList.length} -> ${updatedList.length}개 (+${newEntries.length})`);

  if (existsSync(TMP_SQL)) unlinkSync(TMP_SQL);

  console.log("\n=== 완료 ===");
  console.log("다음 단계:");
  console.log("  1. bun run curate-hell    # 새 항목 태깅");
  console.log("  2. bun run crawl-youtube  # 영상/댓글 수집");
  console.log("  3. bun run seed-reviews   # AI 시드 리뷰 생성");
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
