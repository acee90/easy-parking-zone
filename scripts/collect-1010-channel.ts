/**
 * 10시10분(@1010thtm) 채널 영상에서 주차장 목록 수집
 *
 * Step 1: 채널 영상 목록 수집 (playlistItems API, 1 unit/call)
 * Step 2: Claude Haiku로 영상 제목/설명에서 주차장명 + 난이도 사유 추출
 * Step 3: DB 매칭 → hell-parking-list.json에 신규 항목 추가
 *
 * 사용법: bun run scripts/collect-1010-channel.ts
 *   --fetch-only   영상 목록만 수집 (Step 1)
 *   --parse-only   이미 수집된 목록에서 파싱만 (Step 2-3)
 *   --dry-run      hell-parking-list.json 수정 없이 미리보기
 */
import { writeFileSync, readFileSync, existsSync } from "fs";
import { resolve } from "path";
import Anthropic from "@anthropic-ai/sdk";
import { getUploadsPlaylistId, getChannelVideos, type YouTubeVideo } from "./lib/youtube-api";
import { d1Query } from "./lib/d1";
import { sleep } from "./lib/geo";
import { esc } from "./lib/sql-flush";

// --- Config ---
const CHANNEL_HANDLE = "1010thtm";
const VIDEOS_JSON = resolve(import.meta.dir, "1010-videos.json");
const RESULT_JSON = resolve(import.meta.dir, "1010-parking-result.json");
const HELL_LIST_JSON = resolve(import.meta.dir, "hell-parking-list.json");
const DELAY = 800;
const BATCH_SIZE = 15;

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

function findParkingByName(name: string): { id: string; name: string; address: string }[] {
  const keywords = name
    .replace(/주차장|주차/g, "")
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  if (keywords.length === 0) return [];

  const conditions = keywords.map((kw) => `name LIKE '%${esc(kw)}%'`).join(" AND ");
  return d1Query(`SELECT id, name, address FROM parking_lots WHERE ${conditions} LIMIT 10`);
}

// --- Step 1: 채널 영상 수집 ---
async function fetchVideos(): Promise<YouTubeVideo[]> {
  if (existsSync(VIDEOS_JSON)) {
    const cached = JSON.parse(readFileSync(VIDEOS_JSON, "utf-8"));
    console.log(`캐시된 영상 목록 사용: ${cached.length}개 (${VIDEOS_JSON})`);
    return cached;
  }

  console.log(`채널 @${CHANNEL_HANDLE} 영상 목록 수집 중...`);
  const playlistId = await getUploadsPlaylistId(CHANNEL_HANDLE);
  console.log(`  uploads playlist: ${playlistId}`);

  const videos = await getChannelVideos(playlistId);
  console.log(`  총 ${videos.length}개 영상 수집 완료`);

  writeFileSync(VIDEOS_JSON, JSON.stringify(videos, null, 2));
  console.log(`  저장: ${VIDEOS_JSON}`);
  return videos;
}

// --- Step 2: Claude로 주차장명 추출 ---
async function parseVideos(videos: YouTubeVideo[]): Promise<ParsedParking[]> {
  if (existsSync(RESULT_JSON)) {
    const cached = JSON.parse(readFileSync(RESULT_JSON, "utf-8"));
    console.log(`캐시된 파싱 결과 사용: ${cached.length}개 (${RESULT_JSON})`);
    return cached;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY가 .env에 설정되지 않았습니다.");
    process.exit(1);
  }

  const client = new Anthropic();
  const results: ParsedParking[] = [];

  for (let i = 0; i < videos.length; i += BATCH_SIZE) {
    const batch = videos.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(videos.length / BATCH_SIZE);
    console.log(`\n  배치 ${batchNum}/${totalBatches} (${batch.length}개 영상)`);

    const videoList = batch
      .map((v, idx) => `[${idx + 1}] 제목: ${v.title}\n   설명: ${v.description.slice(0, 200)}`)
      .join("\n\n");

    const prompt = `아래는 유튜브 '10시10분' 채널의 영상 목록입니다. 이 채널은 어려운 주차장을 직접 방문하는 콘텐츠입니다.

각 영상에서 방문한 주차장 정보를 추출해주세요.

${videoList}

응답 형식 (JSON 배열만):
[
  {
    "index": 1,
    "isParking": true,
    "parkingName": "타임스퀘어 주차장",
    "location": "서울 영등포",
    "reason": "좁은 나선형 진입로, 급경사"
  }
]

규칙:
- isParking=false: 주차장과 무관한 영상 (운전 팁, 브이로그, 리뷰 등)
- parkingName: 영상에서 확인 가능한 주차장 정식명칭. 추측 금지.
- location: 시/구 단위 (영상에서 확인 가능한 경우만)
- reason: 영상에서 언급된 난이도 요인 (좁은 진입로, 나선형, 급경사 등). 간결하게.
- 한 영상에 여러 주차장이면 각각 별도 항목으로.`;

    try {
      const response = await client.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      });

      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]) as any[];
        for (const item of parsed) {
          if (!item.isParking) continue;
          const video = batch[item.index - 1];
          if (!video) continue;
          results.push({
            videoId: video.videoId,
            videoTitle: video.title,
            parkingName: item.parkingName,
            location: item.location || "",
            reason: item.reason || "",
            isParking: true,
          });
        }
        const parkingCount = parsed.filter((p: any) => p.isParking).length;
        console.log(`    주차장 ${parkingCount}개 추출`);
      }
    } catch (err) {
      console.error(`    API 오류: ${(err as Error).message.slice(0, 80)}`);
    }

    await sleep(DELAY);
  }

  writeFileSync(RESULT_JSON, JSON.stringify(results, null, 2));
  console.log(`\n  파싱 결과 저장: ${results.length}개 → ${RESULT_JSON}`);
  return results;
}

// --- Step 3: DB 매칭 + hell-parking-list.json 업데이트 ---
function matchAndUpdate(parsed: ParsedParking[], dryRun: boolean) {
  const hellList: HellListEntry[] = JSON.parse(readFileSync(HELL_LIST_JSON, "utf-8"));
  const existingNames = new Set(hellList.map((e) => e.name.replace(/주차장|주차/g, "").trim().toLowerCase()));

  const uniqueMap = new Map<string, ParsedParking>();
  for (const p of parsed) {
    if (!p.parkingName) continue;
    const key = p.parkingName.replace(/주차장|주차/g, "").trim().toLowerCase();
    if (!key || !uniqueMap.has(key)) uniqueMap.set(key, p);
  }

  console.log(`\n--- DB 매칭 ---`);
  console.log(`파싱된 고유 주차장: ${uniqueMap.size}개`);

  const newEntries: HellListEntry[] = [];
  const unmatched: ParsedParking[] = [];
  let alreadyExists = 0;

  for (const [key, p] of uniqueMap) {
    if (existingNames.has(key)) {
      alreadyExists++;
      continue;
    }

    const candidates = findParkingByName(p.parkingName);
    if (candidates.length > 0) {
      const best = candidates[0];
      newEntries.push({
        id: best.id,
        name: best.name,
        tag: "hell",
        reason: p.reason,
      });
      console.log(`  ✅ "${p.parkingName}" → ${best.id} (${best.name})`);
    } else {
      unmatched.push(p);
      console.log(`  ❌ "${p.parkingName}" — DB 매칭 실패`);
    }
  }

  console.log(`\n--- 결과 ---`);
  console.log(`  기존 중복: ${alreadyExists}개`);
  console.log(`  신규 매칭: ${newEntries.length}개`);
  console.log(`  매칭 실패: ${unmatched.length}개`);

  if (unmatched.length > 0) {
    console.log(`\n  [매칭 실패 목록 — 수동 확인 필요]`);
    for (const u of unmatched) {
      console.log(`    - ${u.parkingName} (${u.location}) — ${u.videoTitle}`);
    }
  }

  if (newEntries.length === 0) {
    console.log("\n추가할 신규 항목이 없습니다.");
    return;
  }

  if (dryRun) {
    console.log("\n  [DRY RUN] hell-parking-list.json 수정하지 않음");
    console.log("  추가 예정 항목:");
    for (const e of newEntries) {
      console.log(`    - ${e.name} (${e.id}) — ${e.reason}`);
    }
    return;
  }

  const updated = [...hellList, ...newEntries];
  writeFileSync(HELL_LIST_JSON, JSON.stringify(updated, null, 2));
  console.log(`\nhell-parking-list.json 업데이트: ${hellList.length} → ${updated.length}개 (+${newEntries.length})`);
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  const fetchOnly = args.includes("--fetch-only");
  const parseOnly = args.includes("--parse-only");
  const dryRun = args.includes("--dry-run");

  if (!process.env.YOUTUBE_API_KEY && !parseOnly) {
    console.error("YOUTUBE_API_KEY가 .env에 설정되지 않았습니다.");
    process.exit(1);
  }

  console.log("=== 10시10분 채널 주차장 수집 ===\n");

  const videos = parseOnly
    ? JSON.parse(readFileSync(VIDEOS_JSON, "utf-8"))
    : await fetchVideos();

  if (fetchOnly) {
    console.log("\n--fetch-only: 영상 수집 완료. 파싱은 --parse-only로 별도 실행.");
    return;
  }

  const parsed = await parseVideos(videos);

  matchAndUpdate(parsed, dryRun);

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
