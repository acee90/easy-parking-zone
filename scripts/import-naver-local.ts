/**
 * 네이버 지역 검색 API로 주차장 데이터 추가 수집
 *
 * - 기존 DB 전체를 메모리에 로드하여 빠른 중복 체크
 * - 시군구 × 2 검색어 = ~456 API 호출 (일 25,000 쿼터 대비 여유)
 * - 중복 판별: 이름 일치 + 좌표 200m 이내
 * - 진행상황 scripts/naver-local-progress.json에 저장 → 중단 후 재개 가능
 *
 * 사용법: bun run import-naver-local
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { d1Query as d1QueryLib, d1ExecFile, isRemote } from "./lib/d1";

// ── 환경변수 ──
const CLIENT_ID = process.env.NAVER_CLIENT_ID;
const CLIENT_SECRET = process.env.NAVER_CLIENT_SECRET;
if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET가 .env에 설정되지 않았습니다.");
  process.exit(1);
}

const API_URL = "https://openapi.naver.com/v1/search/local.json";
const PROGRESS_FILE = resolve(import.meta.dir, "naver-local-progress.json");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-naver.sql");
const DELAY = 200; // ms between API calls

// ── 전국 시군구 목록 ──
const REGIONS: string[] = [
  // 서울
  "서울 강남구","서울 강동구","서울 강북구","서울 강서구","서울 관악구","서울 광진구",
  "서울 구로구","서울 금천구","서울 노원구","서울 도봉구","서울 동대문구","서울 동작구",
  "서울 마포구","서울 서대문구","서울 서초구","서울 성동구","서울 성북구","서울 송파구",
  "서울 양천구","서울 영등포구","서울 용산구","서울 은평구","서울 종로구","서울 중구","서울 중랑구",
  // 부산
  "부산 강서구","부산 금정구","부산 기장군","부산 남구","부산 동구","부산 동래구",
  "부산 부산진구","부산 북구","부산 사상구","부산 사하구","부산 서구","부산 수영구",
  "부산 연제구","부산 영도구","부산 중구","부산 해운대구",
  // 대구
  "대구 군위군","대구 남구","대구 달서구","대구 달성군","대구 동구","대구 북구",
  "대구 서구","대구 수성구","대구 중구",
  // 인천
  "인천 강화군","인천 계양구","인천 남동구","인천 동구","인천 미추홀구","인천 부평구",
  "인천 서구","인천 연수구","인천 옹진군","인천 중구",
  // 광주
  "광주 광산구","광주 남구","광주 동구","광주 북구","광주 서구",
  // 대전
  "대전 대덕구","대전 동구","대전 서구","대전 유성구","대전 중구",
  // 울산
  "울산 남구","울산 동구","울산 북구","울산 울주군","울산 중구",
  // 세종
  "세종시",
  // 경기
  "경기 가평군","경기 고양시","경기 과천시","경기 광명시","경기 광주시","경기 구리시",
  "경기 군포시","경기 김포시","경기 남양주시","경기 동두천시","경기 부천시","경기 성남시",
  "경기 수원시","경기 시흥시","경기 안산시","경기 안성시","경기 안양시","경기 양주시",
  "경기 양평군","경기 여주시","경기 연천군","경기 오산시","경기 용인시","경기 의왕시",
  "경기 의정부시","경기 이천시","경기 파주시","경기 평택시","경기 포천시","경기 하남시","경기 화성시",
  // 강원
  "강원 강릉시","강원 고성군","강원 동해시","강원 삼척시","강원 속초시","강원 양구군",
  "강원 양양군","강원 영월군","강원 원주시","강원 인제군","강원 정선군","강원 철원군",
  "강원 춘천시","강원 태백시","강원 평창군","강원 홍천군","강원 화천군","강원 횡성군",
  // 충북
  "충북 괴산군","충북 단양군","충북 보은군","충북 영동군","충북 옥천군","충북 음성군",
  "충북 제천시","충북 증평군","충북 진천군","충북 청주시","충북 충주시",
  // 충남
  "충남 계룡시","충남 공주시","충남 금산군","충남 논산시","충남 당진시","충남 보령시",
  "충남 부여군","충남 서산시","충남 서천군","충남 아산시","충남 예산군","충남 천안시",
  "충남 청양군","충남 태안군","충남 홍성군",
  // 전북
  "전북 고창군","전북 군산시","전북 김제시","전북 남원시","전북 무주군","전북 부안군",
  "전북 순창군","전북 완주군","전북 익산시","전북 임실군","전북 장수군","전북 전주시",
  "전북 정읍시","전북 진안군",
  // 전남
  "전남 강진군","전남 고흥군","전남 곡성군","전남 광양시","전남 구례군","전남 나주시",
  "전남 담양군","전남 목포시","전남 무안군","전남 보성군","전남 순천시","전남 신안군",
  "전남 여수시","전남 영광군","전남 영암군","전남 완도군","전남 장성군","전남 장흥군",
  "전남 진도군","전남 함평군","전남 해남군","전남 화순군",
  // 경북
  "경북 경산시","경북 경주시","경북 고령군","경북 구미시","경북 김천시","경북 문경시",
  "경북 봉화군","경북 상주시","경북 성주군","경북 안동시","경북 영덕군","경북 영양군",
  "경북 영주시","경북 영천시","경북 예천군","경북 울릉군","경북 울진군","경북 의성군",
  "경북 청도군","경북 청송군","경북 칠곡군","경북 포항시",
  // 경남
  "경남 거제시","경남 거창군","경남 고성군","경남 김해시","경남 남해군","경남 밀양시",
  "경남 사천시","경남 산청군","경남 양산시","경남 의령군","경남 진주시","경남 창녕군",
  "경남 창원시","경남 통영시","경남 하동군","경남 함안군","경남 함양군","경남 합천군",
  // 제주
  "제주 제주시","제주 서귀포시",
];

// 검색어 접미사 (2개로 줄여서 API 호출 절약)
const SUFFIXES = ["주차장", "공영주차장"];

// ── Types ──
interface NaverPlace {
  title: string;
  address: string;
  roadAddress: string;
  mapx: string;
  mapy: string;
  telephone: string;
  category: string;
}

interface NaverResponse {
  total: number;
  start: number;
  display: number;
  items: NaverPlace[];
}

interface Progress {
  completedQueries: string[];
  newPlaces: number;
  skippedDuplicates: number;
  totalApiCalls: number;
  startedAt: string;
  lastUpdatedAt: string;
}

interface ExistingLot {
  name: string;
  lat: number;
  lng: number;
}

// ── 좌표 변환 ──
function parseCoords(mapx: string, mapy: string): { lat: number; lng: number } {
  const lng = parseInt(mapx, 10) / 10_000_000;
  const lat = parseInt(mapy, 10) / 10_000_000;
  return { lat, lng };
}

// ── Progress ──
function loadProgress(): Progress {
  if (existsSync(PROGRESS_FILE)) {
    return JSON.parse(readFileSync(PROGRESS_FILE, "utf-8"));
  }
  return {
    completedQueries: [],
    newPlaces: 0,
    skippedDuplicates: 0,
    totalApiCalls: 0,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

function saveProgress(p: Progress) {
  p.lastUpdatedAt = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(p));
}

// ── API ──
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function searchLocal(query: string, progress: Progress): Promise<NaverPlace[]> {
  const params = new URLSearchParams({
    query,
    display: "5",
    start: "1",
    sort: "comment",
  });

  const res = await fetch(`${API_URL}?${params}`, {
    headers: {
      "X-Naver-Client-Id": CLIENT_ID!,
      "X-Naver-Client-Secret": CLIENT_SECRET!,
    },
  });

  progress.totalApiCalls++;

  if (!res.ok) {
    if (res.status === 429) {
      console.log("\n  Rate limited, waiting 10s...");
      await sleep(10000);
      return searchLocal(query, progress);
    }
    const text = await res.text();
    throw new Error(`Naver API ${res.status}: ${text}`);
  }

  await sleep(DELAY);
  const data = (await res.json()) as NaverResponse;
  return data.items ?? [];
}

// ── DB 헬퍼 ──
const d1Query = d1QueryLib;

function esc(s: string): string {
  return s.replace(/'/g, "''").replace(/<\/?b>/g, "");
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "");
}

function inferType(category: string, name: string): string {
  const s = category + name;
  if (s.includes("노상")) return "노상";
  if (s.includes("공영") || s.includes("공용")) return "노외";
  if (s.includes("부설") || s.includes("건물")) return "부설";
  if (s.includes("기계식")) return "부설";
  if (s.includes("민영")) return "노외";
  return "노외";
}

// ── 메모리 기반 중복 체크 ──
function loadExistingLots(): ExistingLot[] {
  console.log("기존 주차장 데이터 로딩 중...");
  const rows = d1Query<ExistingLot>("SELECT name, lat, lng FROM parking_lots");
  console.log(`  ${rows.length}개 로드 완료\n`);
  return rows;
}

function isDuplicate(
  existing: ExistingLot[],
  name: string,
  lat: number,
  lng: number
): boolean {
  return existing.some(
    (lot) =>
      lot.name === name &&
      Math.abs(lot.lat - lat) < 0.002 &&
      Math.abs(lot.lng - lng) < 0.002
  );
}

// ── 메인 ──
async function main() {
  const progress = loadProgress();
  const completedSet = new Set(progress.completedQueries);

  // 기존 DB를 메모리에 로드 (중복 체크용)
  const existingLots = loadExistingLots();
  // 새로 추가하는 것도 중복 체크에 포함
  const newLots: ExistingLot[] = [];

  // 검색어 목록 생성
  const queries: string[] = [];
  for (const region of REGIONS) {
    for (const suffix of SUFFIXES) {
      queries.push(`${region} ${suffix}`);
    }
  }

  const totalQueries = queries.length;
  console.log(`네이버 지역 검색 시작 (${completedSet.size}/${totalQueries} 완료됨)`);
  console.log(`시군구: ${REGIONS.length}개, 접미사: ${SUFFIXES.length}개, 총 검색어: ${totalQueries}개`);
  console.log(`예상 API 호출: ${totalQueries - completedSet.size}회 (일 25,000 쿼터)\n`);

  let pendingSql: string[] = [];
  const FLUSH_SIZE = 100;

  for (let i = 0; i < queries.length; i++) {
    const query = queries[i];
    if (completedSet.has(query)) continue;

    try {
      const places = await searchLocal(query, progress);

      for (const place of places) {
        // 주차장 카테고리 필터
        const title = stripHtml(place.title);
        if (
          !place.category.includes("주차") &&
          !title.includes("주차")
        ) {
          continue;
        }

        if (!place.mapx || !place.mapy) continue;

        const { lat, lng } = parseCoords(place.mapx, place.mapy);

        // 좌표 유효성 (한국 범위)
        if (lat < 33 || lat > 39 || lng < 124 || lng > 132) continue;

        // 기존 DB + 이번 세션 신규 모두에서 중복 체크
        if (
          isDuplicate(existingLots, title, lat, lng) ||
          isDuplicate(newLots, title, lat, lng)
        ) {
          progress.skippedDuplicates++;
          continue;
        }

        const id = `NV-${place.mapx}_${place.mapy}`;
        const address = esc(place.roadAddress || place.address || "");
        const phone = esc(place.telephone || "");
        const type = inferType(place.category, title);

        pendingSql.push(
          `INSERT OR IGNORE INTO parking_lots (id,name,type,address,lat,lng,total_spaces,is_free,phone) VALUES ('${id}','${esc(title)}','${type}','${address}',${lat},${lng},0,0,'${phone}');`
        );
        newLots.push({ name: title, lat, lng });
        progress.newPlaces++;
      }
    } catch (err) {
      console.error(`\n  Error on "${query}": ${(err as Error).message}`);
      if ((err as Error).message.includes("401") || (err as Error).message.includes("403")) {
        console.error("\n인증 에러 - https://developers.naver.com/apps/ 에서 '검색 > 지역' API 활성화 필요");
        saveProgress(progress);
        process.exit(1);
      }
    }

    completedSet.add(query);
    progress.completedQueries.push(query);

    // DB flush
    if (pendingSql.length >= FLUSH_SIZE) {
      writeFileSync(TMP_SQL, pendingSql.join("\n"));
      d1ExecFile(TMP_SQL);
      pendingSql = [];
    }

    // 진행상황 표시
    const pct = ((completedSet.size / totalQueries) * 100).toFixed(1);
    process.stdout.write(
      `\r  ${completedSet.size}/${totalQueries} (${pct}%) | 신규: ${progress.newPlaces} | 중복스킵: ${progress.skippedDuplicates} | API: ${progress.totalApiCalls}`
    );

    // 50개마다 진행상황 저장
    if (completedSet.size % 50 === 0) {
      saveProgress(progress);
    }
  }

  // 나머지 flush
  if (pendingSql.length > 0) {
    writeFileSync(TMP_SQL, pendingSql.join("\n"));
    d1ExecFile(TMP_SQL);
  }

  saveProgress(progress);
  if (existsSync(TMP_SQL)) unlinkSync(TMP_SQL);

  // 최종 결과
  const totalAfter = d1Query<{ cnt: number }>("SELECT COUNT(*) as cnt FROM parking_lots")[0]?.cnt ?? 0;

  console.log(`\n\n=== 완료 ===`);
  console.log(`신규 추가: ${progress.newPlaces}건`);
  console.log(`중복 스킵: ${progress.skippedDuplicates}건`);
  console.log(`API 호출: ${progress.totalApiCalls}회`);
  console.log(`전체 주차장: ${totalAfter}개`);
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
