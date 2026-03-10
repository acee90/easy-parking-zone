/**
 * 클리앙 미매칭 주차장 → 네이버 지역검색으로 DB 등록
 *
 * 1) 네이버 지역검색 API로 주차장 좌표+ID 획득
 * 2) parking_lots INSERT
 * 3) 본문(body) → crawled_reviews INSERT (블로그 탭)
 * 4) 댓글(comment) → reviews INSERT (리뷰 탭)
 *
 * 사용법: bun run scripts/register-clien-unmatched.ts [--dry-run] [--remote]
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import { d1Query, d1ExecFile, isRemote } from "./lib/d1";

const UNMATCHED_JSON = resolve(import.meta.dir, "clien-unmatched.json");
const STILL_UNMATCHED_JSON = resolve(import.meta.dir, "clien-still-unmatched.json");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-clien-register.sql");
const CLIEN_URL = "https://www.clien.net/service/board/cm_car/14055871";
const CLIEN_TITLE = "전국 극악 주차장 총정리";
const DELAY = 250;

const CLIENT_ID = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
const DRY_RUN = process.argv.includes("--dry-run");

interface ClienEntry {
  name: string;
  address: string;
  reason: string;
  from: "body" | "comment";
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function esc(s: string): string {
  return s.replace(/'/g, "''").replace(/<\/?b>/g, "");
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function parseCoords(mapx: string, mapy: string): { lat: number; lng: number } {
  return { lng: parseInt(mapx, 10) / 10_000_000, lat: parseInt(mapy, 10) / 10_000_000 };
}

function sourceId(name: string): string {
  return createHash("md5").update(`${CLIEN_URL}:${name}`).digest("hex").slice(0, 16);
}

// ── 네이버 지역검색 ──
async function searchLocal(query: string): Promise<NaverPlace[]> {
  const params = new URLSearchParams({ query, display: "5", start: "1", sort: "comment" });
  const res = await fetch(`https://openapi.naver.com/v1/search/local.json?${params}`, {
    headers: { "X-Naver-Client-Id": CLIENT_ID!, "X-Naver-Client-Secret": CLIENT_SECRET! },
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
  return ((await res.json()) as { items: NaverPlace[] }).items ?? [];
}

// ── 매칭 검증 ──
function extractKeywords(name: string): string[] {
  return name
    .replace(/주차장|주차|지하|지상|빌딩|타워|프라자|호텔|병원|백화점|건물|점$/g, "")
    .replace(/[()（）\-]/g, " ")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

function validateMatch(
  entry: ClienEntry,
  place: NaverPlace
): { valid: boolean; confidence: "high" | "medium"; failReason: string } {
  const title = stripHtml(place.title);

  // 카테고리/이름에 주차 포함
  if (!place.category.includes("주차") && !title.includes("주차")) {
    return { valid: false, confidence: "medium", failReason: "주차 카테고리/이름 아님" };
  }

  // 좌표 유효성
  if (!place.mapx || !place.mapy) return { valid: false, confidence: "medium", failReason: "좌표 없음" };
  const { lat, lng } = parseCoords(place.mapx, place.mapy);
  if (lat < 33 || lat > 39 || lng < 124 || lng > 132) {
    return { valid: false, confidence: "medium", failReason: "좌표 범위 밖" };
  }

  // 지역 검증
  const address = place.roadAddress || place.address || "";
  const addrParts = entry.address.split(/\s+/).filter((w) => w.length >= 2);
  const broadRegions = new Set(["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"]);
  const narrowParts = addrParts.filter((w) => !broadRegions.has(w.replace(/특별시|광역시|시|도|구|군|동$/g, "")));

  if (narrowParts.length > 0) {
    const hasNarrow = narrowParts.some((p) => address.includes(p.replace(/특별시|광역시|시$|도$|구$|군$|동$/g, "")));
    if (!hasNarrow) return { valid: false, confidence: "medium", failReason: `지역 불일치: "${entry.address}" vs "${address}"` };
  }

  // 키워드 매칭
  const keywords = extractKeywords(entry.name);
  if (keywords.length === 0) return { valid: false, confidence: "medium", failReason: "키워드 추출 실패" };
  const titleLower = title.toLowerCase();
  const matchedKw = keywords.filter((kw) => titleLower.includes(kw.toLowerCase()));
  const ratio = matchedKw.length / keywords.length;

  if (ratio >= 0.8) return { valid: true, confidence: "high", failReason: "" };
  if (ratio >= 0.5 && keywords.length <= 2 && matchedKw.length >= 1) return { valid: true, confidence: "medium", failReason: "" };
  // 매칭 키워드가 0개면 무조건 실패
  if (matchedKw.length === 0) return { valid: false, confidence: "medium", failReason: `키워드 0 매칭 (${keywords.join(",")})` };

  return { valid: false, confidence: "medium", failReason: `키워드 불일치 (${matchedKw.join(",")}/${keywords.join(",")})` };
}

// ── Main ──
async function main() {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수 필요");
    process.exit(1);
  }

  const entries: ClienEntry[] = JSON.parse(readFileSync(UNMATCHED_JSON, "utf-8"));
  // 중복 이름 제거 (body 우선)
  const seen = new Set<string>();
  const unique: ClienEntry[] = [];
  for (const e of entries) {
    const key = e.name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(e);
    }
  }

  // 기존 DB 로드
  const existingIds = new Set(d1Query<{ id: string }>("SELECT id FROM parking_lots").map((r) => r.id));

  if (isRemote) console.log("🌐 리모트 D1 모드\n");
  console.log(`=== 클리앙 미매칭 네이버 등록 시작 ===`);
  console.log(`대상: ${unique.length}개${DRY_RUN ? " [DRY RUN]" : ""}\n`);

  interface MatchResult {
    entry: ClienEntry;
    place: NaverPlace;
    id: string;
    name: string;
    lat: number;
    lng: number;
    confidence: "high" | "medium";
  }

  const matched: MatchResult[] = [];
  const failed: (ClienEntry & { failReason: string })[] = [];
  const newIds = new Set<string>();

  for (let i = 0; i < unique.length; i++) {
    const entry = unique[i];
    const num = `[${i + 1}/${unique.length}]`;

    const queries = [`${entry.address} ${entry.name} 주차장`, `${entry.name} 주차장`];
    let best: MatchResult | null = null;

    for (const query of queries) {
      try {
        const places = await searchLocal(query);
        for (const place of places) {
          const v = validateMatch(entry, place);
          if (!v.valid) continue;

          const title = stripHtml(place.title);
          const { lat, lng } = parseCoords(place.mapx, place.mapy);
          const id = `NV-${place.mapx}_${place.mapy}`;

          if (existingIds.has(id) || newIds.has(id)) continue;

          if (!best || v.confidence === "high") {
            best = { entry, place, id, name: title, lat, lng, confidence: v.confidence };
            if (v.confidence === "high") break;
          }
        }
      } catch (err) {
        console.error(`  ${num} API 오류: ${(err as Error).message.slice(0, 60)}`);
      }
      if (best?.confidence === "high") break;
    }

    if (best) {
      matched.push(best);
      newIds.add(best.id);
      existingIds.add(best.id);
      const conf = best.confidence === "high" ? "H" : "M";
      console.log(`  ${num} [${conf}] "${entry.name}" → ${best.name} (${best.place.roadAddress || best.place.address})`);
    } else {
      failed.push({ ...entry, failReason: "네이버 검색 매칭 실패" });
      console.log(`  ${num} ✗ "${entry.name}" (${entry.address})`);
    }
  }

  console.log(`\n📊 결과: ${matched.length}개 매칭, ${failed.length}개 실패`);

  // 실패 리스트 저장
  writeFileSync(STILL_UNMATCHED_JSON, JSON.stringify(failed, null, 2));

  if (matched.length === 0 || DRY_RUN) {
    if (DRY_RUN && matched.length > 0) {
      console.log("\n[DRY RUN] 추가 예정:");
      for (const m of matched) console.log(`  [${m.confidence}] ${m.name} (${m.id})`);
    }
    return;
  }

  // SQL 생성
  const stmts: string[] = [];

  // 1) parking_lots INSERT
  for (const m of matched) {
    const addr = esc(m.place.roadAddress || m.place.address || "");
    const phone = esc(m.place.telephone || "");
    stmts.push(`INSERT OR IGNORE INTO parking_lots (id,name,type,address,lat,lng,total_spaces,is_free,phone) VALUES ('${m.id}','${esc(m.name)}','부설','${addr}',${m.lat},${m.lng},0,0,'${phone}');`);
  }

  // 2) 본문 → crawled_reviews, 댓글 → reviews
  for (const m of matched) {
    if (m.entry.from === "body") {
      const sid = sourceId(m.entry.name);
      stmts.push(`INSERT OR IGNORE INTO crawled_reviews (parking_lot_id, source, source_id, title, content, source_url, author, relevance_score) VALUES ('${esc(m.id)}', 'clien', '${sid}', '${esc(CLIEN_TITLE)}', '${esc(m.entry.reason)}', '${esc(CLIEN_URL)}', '클리앙', 80);`);
    } else {
      stmts.push(`INSERT INTO reviews (parking_lot_id, guest_nickname, entry_score, space_score, passage_score, exit_score, overall_score, comment, is_seed, source_type, source_url) VALUES ('${esc(m.id)}', '클리앙 사용자', 1, 1, 1, 1, 1, '${esc(m.entry.reason)}', 1, 'clien', '${esc(CLIEN_URL)}');`);
    }
  }

  // 3) hell-parking-list.json 업데이트
  const hellListPath = resolve(import.meta.dir, "hell-parking-list.json");
  const hellList = JSON.parse(readFileSync(hellListPath, "utf-8"));
  const newEntries = matched.map((m) => ({
    id: m.id,
    name: m.name,
    tag: "hell" as const,
    reason: m.entry.reason,
  }));
  writeFileSync(hellListPath, JSON.stringify([...hellList, ...newEntries], null, 2));

  // 실행
  writeFileSync(TMP_SQL, stmts.join("\n"));
  d1ExecFile(TMP_SQL);
  if (existsSync(TMP_SQL)) unlinkSync(TMP_SQL);

  console.log(`\n✅ ${matched.length}개 주차장 등록 + 데이터 INSERT 완료`);
  console.log(`  hell-parking-list.json: ${hellList.length} → ${hellList.length + newEntries.length}개`);
  console.log(`  실패 리스트: ${STILL_UNMATCHED_JSON}`);
  console.log("\n다음 단계:");
  console.log("  bun run scripts/curate-hell-parking.ts  # 새 항목 태깅");
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
