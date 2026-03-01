/**
 * 카카오 Local API PK6 카테고리로 전국 주차장 데이터 수집
 *
 * - 진행상황을 scripts/kakao-progress.json에 저장 → 중단 후 재개 가능
 * - scripts/kakao-progress.md에 사람이 읽을 수 있는 현황 기록
 * - INSERT OR IGNORE로 기존 데이터와 중복 방지
 *
 * 사용법: bun run import-kakao
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { resolve } from "path";

const API_KEY = process.env.KAKAO_REST_API_KEY;
if (!API_KEY) {
  console.error("KAKAO_REST_API_KEY가 .env에 설정되지 않았습니다.");
  process.exit(1);
}

const API_URL = "https://dapi.kakao.com/v2/local/search/category.json";
const CATEGORY = "PK6";

const PROGRESS_JSON = resolve(import.meta.dir, "kakao-progress.json");
const PROGRESS_MD = resolve(import.meta.dir, "kakao-progress.md");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-kakao.sql");

// 한국 영역
const KOREA = { south: 33.1, north: 38.6, west: 125.0, east: 131.9 };
const GRID_SIZE = 0.1;
const DELAY = 80;

// --- Types ---
interface KakaoPlace {
  id: string;
  place_name: string;
  category_name: string;
  address_name: string;
  road_address_name: string;
  x: string;
  y: string;
  phone: string;
}

interface KakaoResponse {
  meta: { total_count: number; pageable_count: number; is_end: boolean };
  documents: KakaoPlace[];
}

interface Progress {
  completedCells: string[]; // "latIdx,lngIdx" 형태
  collectedIds: string[];   // 카카오 place id 목록
  totalPlaces: number;
  totalApiCalls: number;
  dbSavedCount: number;
  startedAt: string;
  lastUpdatedAt: string;
}

// --- Progress management ---
function loadProgress(): Progress {
  if (existsSync(PROGRESS_JSON)) {
    return JSON.parse(readFileSync(PROGRESS_JSON, "utf-8"));
  }
  return {
    completedCells: [],
    collectedIds: [],
    totalPlaces: 0,
    totalApiCalls: 0,
    dbSavedCount: 0,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

function saveProgress(p: Progress) {
  p.lastUpdatedAt = new Date().toISOString();
  writeFileSync(PROGRESS_JSON, JSON.stringify(p));
  updateProgressMd(p);
}

function updateProgressMd(p: Progress) {
  const latSteps = Math.ceil((KOREA.north - KOREA.south) / GRID_SIZE);
  const lngSteps = Math.ceil((KOREA.east - KOREA.west) / GRID_SIZE);
  const totalCells = latSteps * lngSteps;
  const pct = ((p.completedCells.length / totalCells) * 100).toFixed(1);

  const md = `# 카카오 API 주차장 수집 진행현황

| 항목 | 값 |
|------|-----|
| 스캔 셀 | ${p.completedCells.length} / ${totalCells} (${pct}%) |
| 수집 주차장 | ${p.totalPlaces}건 |
| DB 저장 | ${p.dbSavedCount}건 |
| API 호출 | ${p.totalApiCalls}회 |
| 시작 | ${p.startedAt} |
| 최종 업데이트 | ${p.lastUpdatedAt} |

## 상태
${p.completedCells.length >= totalCells ? "✅ 완료" : "🔄 진행 중..."}
`;
  writeFileSync(PROGRESS_MD, md);
}

// --- API ---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchCategory(
  rect: string,
  page: number,
  progress: Progress
): Promise<KakaoResponse> {
  const params = new URLSearchParams({
    category_group_code: CATEGORY,
    rect,
    page: String(page),
    size: "15",
    sort: "accuracy",
  });

  const res = await fetch(`${API_URL}?${params}`, {
    headers: { Authorization: `KakaoAK ${API_KEY}` },
  });

  progress.totalApiCalls++;

  if (!res.ok) {
    if (res.status === 429) {
      console.log("  Rate limited, waiting 5s...");
      await sleep(5000);
      return fetchCategory(rect, page, progress);
    }
    throw new Error(`Kakao API ${res.status}`);
  }

  await sleep(DELAY);
  return res.json() as Promise<KakaoResponse>;
}

async function collectCell(
  west: number,
  south: number,
  east: number,
  north: number,
  progress: Progress,
  depth: number = 0
): Promise<KakaoPlace[]> {
  const rect = `${west},${south},${east},${north}`;
  const first = await fetchCategory(rect, 1, progress);

  if (first.meta.total_count === 0) return [];

  // 675건 초과 → 4분할
  if (first.meta.total_count > 675 && depth < 4) {
    const midLat = (south + north) / 2;
    const midLng = (west + east) / 2;
    const r1 = await collectCell(west, south, midLng, midLat, progress, depth + 1);
    const r2 = await collectCell(midLng, south, east, midLat, progress, depth + 1);
    const r3 = await collectCell(west, midLat, midLng, north, progress, depth + 1);
    const r4 = await collectCell(midLng, midLat, east, north, progress, depth + 1);
    return [...r1, ...r2, ...r3, ...r4];
  }

  const places = [...first.documents];
  let isEnd = first.meta.is_end;
  let page = 2;
  while (!isEnd && page <= 45) {
    const res = await fetchCategory(rect, page, progress);
    places.push(...res.documents);
    isEnd = res.meta.is_end;
    page++;
  }

  return places;
}

// --- DB ---
function esc(s: string): string {
  return s.replace(/'/g, "''");
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

function saveBatchToDB(places: KakaoPlace[], progress: Progress) {
  if (places.length === 0) return;

  const stmts = places
    .map((p) => {
      const id = `KA-${p.id}`;
      const name = esc(p.place_name);
      const type = inferType(p.category_name, p.place_name);
      const address = esc(p.road_address_name || p.address_name || "");
      const lat = parseFloat(p.y);
      const lng = parseFloat(p.x);
      const phone = esc(p.phone || "");
      return `INSERT OR IGNORE INTO parking_lots (id,name,type,address,lat,lng,total_spaces,is_free,phone) VALUES ('${id}','${name}','${type}','${address}',${lat},${lng},0,0,'${phone}');`;
    })
    .join("\n");

  writeFileSync(TMP_SQL, stmts);
  execSync(`npx wrangler d1 execute parking-db --local --file="${TMP_SQL}"`, {
    stdio: "pipe",
  });
  progress.dbSavedCount += places.length;
}

// --- Main ---
async function main() {
  const progress = loadProgress();
  const completedSet = new Set(progress.completedCells);
  const collectedIdSet = new Set(progress.collectedIds);

  const latSteps = Math.ceil((KOREA.north - KOREA.south) / GRID_SIZE);
  const lngSteps = Math.ceil((KOREA.east - KOREA.west) / GRID_SIZE);
  const totalCells = latSteps * lngSteps;

  console.log(`카카오 PK6 수집 시작 (${completedSet.size}/${totalCells} 셀 완료됨)`);
  saveProgress(progress);

  // 새로 수집된 place를 모아서 주기적으로 DB 저장
  let pendingPlaces: KakaoPlace[] = [];
  const DB_FLUSH_SIZE = 200;

  for (let latIdx = 0; latIdx < latSteps; latIdx++) {
    const south = KOREA.south + latIdx * GRID_SIZE;
    const north = Math.min(south + GRID_SIZE, KOREA.north);

    for (let lngIdx = 0; lngIdx < lngSteps; lngIdx++) {
      const cellKey = `${latIdx},${lngIdx}`;
      if (completedSet.has(cellKey)) continue;

      const west = KOREA.west + lngIdx * GRID_SIZE;
      const east = Math.min(west + GRID_SIZE, KOREA.east);

      try {
        const places = await collectCell(west, south, east, north, progress);

        for (const p of places) {
          if (!collectedIdSet.has(p.id)) {
            collectedIdSet.add(p.id);
            pendingPlaces.push(p);
            progress.totalPlaces++;
          }
        }
      } catch {
        // 에러 셀 스킵
      }

      completedSet.add(cellKey);
      progress.completedCells.push(cellKey);

      // DB flush
      if (pendingPlaces.length >= DB_FLUSH_SIZE) {
        saveBatchToDB(pendingPlaces, progress);
        pendingPlaces = [];
      }

      // 50셀마다 진행상황 저장
      if (completedSet.size % 50 === 0) {
        progress.collectedIds = [...collectedIdSet];
        saveProgress(progress);
        process.stdout.write(
          `\r  ${completedSet.size}/${totalCells} (${((completedSet.size / totalCells) * 100).toFixed(1)}%) | ${progress.totalPlaces}건 | API ${progress.totalApiCalls}회`
        );
      }
    }
  }

  // 나머지 flush
  if (pendingPlaces.length > 0) {
    saveBatchToDB(pendingPlaces, progress);
  }

  progress.collectedIds = [...collectedIdSet];
  saveProgress(progress);

  if (existsSync(TMP_SQL)) unlinkSync(TMP_SQL);

  console.log(`\n\n✅ 완료! ${progress.totalPlaces}건 수집, DB ${progress.dbSavedCount}건 저장`);
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
