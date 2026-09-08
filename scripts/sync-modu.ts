/**
 * 모두의주차장(api.modu.cloud) 지도 핀 → D1 신규 등록
 *
 * 사용법:
 *   bun run scripts/sync-modu.ts                           # 서울 bbox, 로컬 D1
 *   bun run scripts/sync-modu.ts --remote                  # 리모트 D1
 *   bun run scripts/sync-modu.ts --dry-run                 # 변경사항만 출력, DB 미반영
 *   bun run scripts/sync-modu.ts --swlat=.. --swlng=.. --nelat=.. --nelng=..  # bbox 직접 지정
 *
 * 소스: https://api.modu.cloud/poi/pins (인증 불필요, geohash 6자리 셀 단위 조회)
 * 핀 데이터에 도로명주소가 없어 NCP Reverse Geocoding으로 좌표→주소 변환 후 등록.
 * 기존 KA-/NV-/공공데이터/HP-와 좌표 반경 dedup 후 겹치지 않는 건만 MODU-{parkinglotSeq}로 신규 등록.
 * 배치 내부 중복(같은 주차장이 다른 seq로 두 번 내려오는 경우)은 이름 일치 + 반경으로 한 번 더 거른다.
 *
 * 환경변수: NAVER_MAP_CLIENT_ID, NAVER_MAP_CLIENT_SECRET (Naver Cloud Platform Maps > Reverse Geocoding)
 */
import { resolve } from "path";
import { d1ExecFile, isRemote } from "./lib/d1";
import { sqlVal } from "./lib/sql-flush";
import { type ExistingLot, loadExistingLots, nearestLot, nearestSameNameLot } from "./lib/place-match";
import { writeFileSync, unlinkSync } from "fs";

const DRY_RUN = process.argv.includes("--dry-run");
const DEDUP_RADIUS_M = 60;
const GEOCODE_DELAY_MS = 120;
const PINS_DELAY_MS = 250;

const NCP_CLIENT_ID = process.env.NAVER_MAP_CLIENT_ID;
const NCP_CLIENT_SECRET = process.env.NAVER_MAP_CLIENT_SECRET;
if (!NCP_CLIENT_ID || !NCP_CLIENT_SECRET) {
  console.error("❌ NAVER_MAP_CLIENT_ID / NAVER_MAP_CLIENT_SECRET 환경변수가 필요합니다.");
  process.exit(1);
}

function getArg(name: string, fallback: number): number {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseFloat(arg.split("=")[1]) : fallback;
}

// 기본값: 서울 전역 bbox
const SW_LAT = getArg("swlat", 37.41);
const SW_LNG = getArg("swlng", 126.76);
const NE_LAT = getArg("nelat", 37.71);
const NE_LNG = getArg("nelng", 127.19);

// ── geohash (base32, precision 6 ≈ 1.2km x 0.6km) ──

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

function encodeGeohash(lat: number, lng: number, precision = 6): string {
  let latRange: [number, number] = [-90, 90];
  let lngRange: [number, number] = [-180, 180];
  let hash = "";
  let even = true;
  let bit = 0;
  let ch = 0;

  while (hash.length < precision) {
    if (even) {
      const mid = (lngRange[0] + lngRange[1]) / 2;
      if (lng > mid) {
        ch |= 1 << (4 - bit);
        lngRange[0] = mid;
      } else {
        lngRange[1] = mid;
      }
    } else {
      const mid = (latRange[0] + latRange[1]) / 2;
      if (lat > mid) {
        ch |= 1 << (4 - bit);
        latRange[0] = mid;
      } else {
        latRange[1] = mid;
      }
    }
    even = !even;
    if (bit < 4) {
      bit++;
    } else {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

function geohashCellsInBbox(swLat: number, swLng: number, neLat: number, neLng: number): string[] {
  const LAT_STEP = 0.002;
  const LNG_STEP = 0.003;
  const cells = new Set<string>();
  for (let lat = swLat; lat <= neLat; lat += LAT_STEP) {
    for (let lng = swLng; lng <= neLng; lng += LNG_STEP) {
      cells.add(encodeGeohash(lat, lng, 6));
    }
  }
  return [...cells];
}

// ── api.modu.cloud ──

interface PinItem {
  parkinglotSeq: number;
  name: string;
  latitude: number;
  longitude: number;
  qty: number;
  isFree: boolean;
  calcPrice: Record<string, number>;
}

async function fetchPinsBatch(geohashes: string[]): Promise<PinItem[]> {
  const today = new Date().toISOString().slice(0, 10);
  const url = `https://api.modu.cloud/poi/pins?geohash=${geohashes.join(",")}&durationId=PT1H&parkingDate=${today}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
  const json: any = await res.json();
  const items: PinItem[] = [];
  for (const group of json.data ?? []) {
    for (const p of group.parkinglots ?? []) items.push(p);
  }
  return items;
}

async function fetchAllPins(swLat: number, swLng: number, neLat: number, neLng: number): Promise<Map<number, PinItem>> {
  const cells = geohashCellsInBbox(swLat, swLng, neLat, neLng);
  console.log(`geohash 셀 ${cells.length}개, ${Math.ceil(cells.length / 9)}회 호출 예정`);

  const byId = new Map<number, PinItem>();
  for (let i = 0; i < cells.length; i += 9) {
    const batch = cells.slice(i, i + 9);
    const items = await fetchPinsBatch(batch);
    for (const item of items) byId.set(item.parkinglotSeq, item);
    const done = Math.min(i + 9, cells.length);
    process.stdout.write(`\r  ${done}/${cells.length}셀 (누적 ${byId.size}개 lot)`);
    await sleep(PINS_DELAY_MS);
  }
  console.log();
  return byId;
}

// ── NCP Reverse Geocoding ──

async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const url = `https://maps.apigw.ntruss.com/map-reversegeocode/v2/gc?coords=${lng},${lat}&output=json&orders=roadaddr,addr`;
  const res = await fetch(url, {
    headers: {
      "x-ncp-apigw-api-key-id": NCP_CLIENT_ID!,
      "x-ncp-apigw-api-key": NCP_CLIENT_SECRET!,
    },
  });
  if (!res.ok) return null;
  const json: any = await res.json();
  const region = json.results?.[0];
  if (!region) return null;

  const land = region.land;
  const area = region.region?.area1?.name && region.region?.area2?.name
    ? `${region.region.area1.name} ${region.region.area2.name} ${region.region.area3?.name ?? ""}`.trim()
    : "";

  if (region.name === "roadaddr" && land) {
    const roadName = land.name ?? "";
    const buildingNo = [land.number1, land.number2].filter(Boolean).join("-");
    return `${area} ${roadName} ${buildingNo}`.replace(/\s+/g, " ").trim();
  }
  if (land) {
    const jibun = [land.number1, land.number2].filter(Boolean).join("-");
    return `${area} ${jibun}`.replace(/\s+/g, " ").trim();
  }
  return area || null;
}

// ── 매핑 / UPSERT ──

interface DbRow {
  id: string;
  name: string;
  type: string;
  address: string;
  lat: number;
  lng: number;
  total_spaces: number;
  is_free: number;
  base_time: number | null;
  base_fee: number | null;
}

function buildUpsert(row: DbRow): string {
  const cols = ["id", "name", "type", "address", "lat", "lng", "total_spaces", "is_free", "base_time", "base_fee"];
  const vals = [
    sqlVal(row.id), sqlVal(row.name), sqlVal(row.type), sqlVal(row.address),
    row.lat, row.lng, row.total_spaces, row.is_free,
    sqlVal(row.base_time), sqlVal(row.base_fee),
  ];
  const updateSet = cols
    .filter((c) => c !== "id")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  return `INSERT INTO parking_lots (${cols.join(", ")}) VALUES (${vals.join(", ")}) ON CONFLICT(id) DO UPDATE SET ${updateSet}, updated_at = datetime('now');`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── 메인 ──

async function main() {
  console.log(`=== 모두의주차장(MODU) 지점 동기화 ===`);
  console.log(`모드: ${DRY_RUN ? "DRY-RUN (DB 미반영)" : isRemote ? "REMOTE" : "LOCAL"}`);
  console.log(`bbox: (${SW_LAT}, ${SW_LNG}) ~ (${NE_LAT}, ${NE_LNG})\n`);

  console.log("📡 핀 데이터 수집 중...");
  const pinsById = await fetchAllPins(SW_LAT, SW_LNG, NE_LAT, NE_LNG);
  console.log(`API 총 ${pinsById.size}건 (중복 제거 후)\n`);

  console.log("💾 기존 DB 주차장 로드 중 (좌표 dedup)...");
  const existingLots = loadExistingLots();
  const existingIds = new Set(existingLots.map((l) => l.id));
  console.log(`기존 ${existingLots.length.toLocaleString()}건 로드\n`);

  const candidates: { id: string; item: PinItem }[] = [];
  const collisions: { modu_name: string; existing: { id: string; name: string }; dist: number }[] = [];
  // 이번 배치에서 이미 채택한 핀. MODU는 같은 주차장을 서로 다른 parkinglotSeq로
  // 여러 번 내려주는 경우가 있어(예: "파크 민영 주차장" 158794/260445, 15m),
  // existingLots만 보면 배치 안에서 서로를 못 보고 둘 다 등록된다.
  const acceptedLots: ExistingLot[] = [];
  const intraDupes: { modu_name: string; accepted: { id: string; name: string }; dist: number }[] = [];

  for (const item of pinsById.values()) {
    const id = `MODU-${item.parkinglotSeq}`;
    if (existingIds.has(id)) continue; // 재실행 시 갱신은 이번 스코프에서 생략

    const nearest = nearestLot(item.latitude, item.longitude, existingLots);
    if (nearest && nearest.dist <= DEDUP_RADIUS_M) {
      collisions.push({ modu_name: item.name, existing: { id: nearest.lot.id, name: nearest.lot.name }, dist: nearest.dist });
      continue;
    }

    // 배치 내부는 "이름 무관 최근접"이 아니라 이름이 같은 경우만 중복으로 본다.
    // 밀집 지역에는 이름이 다른 별개 주차장이 수십 m 안에 흔하다.
    const twin = nearestSameNameLot(item.latitude, item.longitude, item.name, acceptedLots, DEDUP_RADIUS_M);
    if (twin) {
      intraDupes.push({ modu_name: item.name, accepted: { id: twin.lot.id, name: twin.lot.name }, dist: twin.dist });
      continue;
    }

    candidates.push({ id, item });
    acceptedLots.push({ id, name: item.name, lat: item.latitude, lng: item.longitude });
  }

  console.log("📊 비교 결과:");
  console.log(`  신규 후보: ${candidates.length}건`);
  console.log(`  기존 lot과 ${DEDUP_RADIUS_M}m 이내 충돌(스킵): ${collisions.length}건`);
  console.log(`  배치 내부 동일 이름 중복(스킵): ${intraDupes.length}건\n`);

  if (intraDupes.length > 0) {
    const outPath = resolve(import.meta.dir, "../data/modu-intra-dupes.json");
    writeFileSync(outPath, JSON.stringify(intraDupes.map((c) => ({ ...c, dist_m: Math.round(c.dist) })), null, 2));
    console.log(`⚠️  배치 내부 중복 목록 저장: ${outPath}\n`);
  }

  if (collisions.length > 0) {
    const outPath = resolve(import.meta.dir, "../data/modu-dedup-collisions.json");
    writeFileSync(outPath, JSON.stringify(collisions.map((c) => ({ ...c, dist_m: Math.round(c.dist) })), null, 2));
    console.log(`⚠️  충돌 목록 저장: ${outPath}\n`);
  }

  if (candidates.length === 0) {
    console.log("✅ 신규 건 없음. 종료.");
    return;
  }

  if (DRY_RUN) {
    console.log(`🔍 DRY-RUN: 역지오코딩 생략, ${candidates.length}건 신규 등록 예정 (DB 미반영)`);
    return;
  }

  console.log(`📍 역지오코딩 중 (${candidates.length}건)...`);
  const rows: DbRow[] = [];
  let geocodeFailed = 0;
  for (let i = 0; i < candidates.length; i++) {
    const { id, item } = candidates[i];
    const address = await reverseGeocode(item.latitude, item.longitude);
    if (!address) {
      geocodeFailed++;
    } else {
      const hourFee = item.calcPrice?.["60"];
      rows.push({
        id,
        name: item.name.trim(),
        type: "부설",
        address,
        lat: item.latitude,
        lng: item.longitude,
        total_spaces: item.qty || 0,
        is_free: item.isFree ? 1 : 0,
        base_time: !item.isFree && hourFee != null ? 60 : null,
        base_fee: !item.isFree && hourFee != null ? hourFee : null,
      });
    }
    process.stdout.write(`\r  ${i + 1}/${candidates.length} (실패 ${geocodeFailed})`);
    await sleep(GEOCODE_DELAY_MS);
  }
  console.log(`\n\n역지오코딩 완료: ${rows.length}건 성공, ${geocodeFailed}건 실패(스킵)\n`);

  console.log(`⚡ ${rows.length}건 UPSERT 실행 중...`);
  const BATCH = 100;
  const tmpSql = resolve(import.meta.dir, "../.tmp-modu.sql");

  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const stmts = slice.map(buildUpsert).join("\n");
    writeFileSync(tmpSql, stmts);
    d1ExecFile(tmpSql);

    const done = Math.min(i + BATCH, rows.length);
    process.stdout.write(`\r  ${done}/${rows.length} (${Math.round((done / rows.length) * 100)}%)`);
  }

  try { unlinkSync(tmpSql); } catch {}
  console.log(`\n\n✅ 완료! ${rows.length}건 신규 등록`);
}

main().catch((err) => {
  console.error("❌ 에러:", err.message ?? err);
  process.exit(1);
});
