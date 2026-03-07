/**
 * 헬 주차장 YouTube 영상/댓글 수집
 *
 * - curated 주차장(is_curated=1)에 대해 YouTube 영상 검색
 * - 영상 URL/썸네일 → parking_media 테이블
 * - 주차 관련 댓글 → crawled_reviews 테이블 (source='youtube_comment')
 * - 진행상황을 scripts/youtube-progress.json에 저장 → 중단 후 재개 가능
 *
 * 사용법: bun run scripts/crawl-youtube.ts
 *
 * API 비용:
 *   search.list = 100 units, commentThreads.list = 1 unit
 *   무료 할당 10,000 units/일 → 주차장 ~90개 처리 가능
 */
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { searchVideos, getComments, type YouTubeVideo, type YouTubeComment } from "./lib/youtube-api";
import { hashUrl } from "./lib/naver-api";
import { d1Query, d1ExecFile, isRemote } from "./lib/d1";

// --- Config ---
const DELAY = 500; // API 호출 간 딜레이 (ms)
const VIDEOS_PER_LOT = 3; // 주차장당 검색 영상 수
const COMMENTS_PER_VIDEO = 10; // 영상당 댓글 수
const DB_FLUSH_SIZE = 30;

const PROGRESS_JSON = resolve(import.meta.dir, "youtube-progress.json");
const TMP_SQL = resolve(import.meta.dir, "../.tmp-youtube.sql");

// --- Types ---
interface ParkingRow {
  id: string;
  name: string;
  address: string;
  curation_tag: string;
}

interface Progress {
  completedIds: string[];
  totalSearchCalls: number;
  totalCommentCalls: number;
  savedMedia: number;
  savedComments: number;
  startedAt: string;
  lastUpdatedAt: string;
}

interface PendingMedia {
  parkingLotId: string;
  videoId: string;
  url: string;
  title: string;
  thumbnailUrl: string;
  description: string;
}

interface PendingComment {
  parkingLotId: string;
  sourceId: string;
  title: string;
  content: string;
  sourceUrl: string;
  author: string;
  publishedAt: string | null;
  relevanceScore: number;
}

// --- Progress ---
function loadProgress(): Progress {
  if (existsSync(PROGRESS_JSON)) {
    return JSON.parse(readFileSync(PROGRESS_JSON, "utf-8"));
  }
  return {
    completedIds: [],
    totalSearchCalls: 0,
    totalCommentCalls: 0,
    savedMedia: 0,
    savedComments: 0,
    startedAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
  };
}

function saveProgress(p: Progress) {
  p.lastUpdatedAt = new Date().toISOString();
  writeFileSync(PROGRESS_JSON, JSON.stringify(p, null, 2));
}

// --- Helpers ---
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function esc(s: string): string {
  return s.replace(/'/g, "''");
}

/** 주소에서 구/동 추출 */
function extractRegion(address: string): string {
  const parts = address.split(/\s+/);
  for (const part of parts) {
    if (/(구|군)$/.test(part)) return part;
  }
  return "";
}

/** 댓글이 주차와 관련있는지 점수 매기기 (0-100) */
function scoreComment(text: string, parkingName: string): number {
  let score = 0;
  const t = text.toLowerCase();

  // 주차 관련 키워드
  const parkingKeywords = ["주차", "parking", "차", "운전"];
  const difficultyKeywords = ["좁", "무서", "힘들", "긁", "어려", "공포", "골뱅이", "나선", "경사", "회전", "기둥"];
  const positiveKeywords = ["넓", "쉬", "편", "여유", "추천"];

  if (parkingKeywords.some((kw) => t.includes(kw))) score += 30;
  if (difficultyKeywords.some((kw) => t.includes(kw))) score += 40;
  if (positiveKeywords.some((kw) => t.includes(kw))) score += 20;

  // 주차장 이름 키워드 매칭
  const nameWords = parkingName
    .replace(/주차장|주차/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (nameWords.some((kw) => t.includes(kw.toLowerCase()))) score += 20;

  // 너무 짧은 댓글은 감점
  if (text.length < 10) score -= 20;

  return Math.max(0, Math.min(100, score));
}

// --- DB helpers ---
function flushMediaToDB(items: PendingMedia[], progress: Progress) {
  if (items.length === 0) return;

  const stmts = items
    .map(
      (m) =>
        `INSERT OR IGNORE INTO parking_media (parking_lot_id, media_type, url, title, thumbnail_url, description) VALUES ('${esc(m.parkingLotId)}', 'youtube', '${esc(m.url)}', '${esc(m.title)}', '${esc(m.thumbnailUrl)}', '${esc(m.description)}');`
    )
    .join("\n");

  writeFileSync(TMP_SQL, stmts);
  d1ExecFile(TMP_SQL);
  progress.savedMedia += items.length;
}

function flushCommentsToDB(items: PendingComment[], progress: Progress) {
  if (items.length === 0) return;

  const stmts = items
    .map(
      (c) =>
        `INSERT OR IGNORE INTO crawled_reviews (parking_lot_id, source, source_id, title, content, source_url, author, published_at, relevance_score) VALUES ('${esc(c.parkingLotId)}', 'youtube_comment', '${c.sourceId}', '${esc(c.title)}', '${esc(c.content)}', '${esc(c.sourceUrl)}', '${esc(c.author)}', ${c.publishedAt ? `'${c.publishedAt}'` : "NULL"}, ${c.relevanceScore});`
    )
    .join("\n");

  writeFileSync(TMP_SQL, stmts);
  d1ExecFile(TMP_SQL);
  progress.savedComments += items.length;
}

// --- Main ---
async function main() {
  if (!process.env.YOUTUBE_API_KEY) {
    console.error("YOUTUBE_API_KEY가 .env에 설정되지 않았습니다.");
    console.error("Google Cloud Console → YouTube Data API v3 → API 키 발급 필요");
    process.exit(1);
  }

  const progress = loadProgress();
  const completedSet = new Set(progress.completedIds);

  // curated 주차장만 대상
  if (isRemote) console.log("🌐 리모트 D1 모드\n");
  console.log("큐레이션된 주차장 조회 중...");
  const lots: ParkingRow[] = d1Query("SELECT id, name, address, curation_tag FROM parking_lots WHERE is_curated = 1");
  const remaining = lots.filter((l) => !completedSet.has(l.id));
  console.log(`총 ${lots.length}개 큐레이션 주차장, ${completedSet.size}개 완료됨, ${remaining.length}개 남음`);

  let pendingMedia: PendingMedia[] = [];
  let pendingComments: PendingComment[] = [];
  let processed = 0;

  for (const lot of remaining) {
    const region = extractRegion(lot.address);
    const query = `${lot.name} ${region} 주차`.trim();

    console.log(`\n[${processed + 1}/${remaining.length}] ${lot.name} (${lot.curation_tag})`);
    console.log(`  검색: "${query}"`);

    // 1) 영상 검색
    let videos: YouTubeVideo[] = [];
    try {
      videos = await searchVideos(query, VIDEOS_PER_LOT);
      progress.totalSearchCalls++;
      console.log(`  영상 ${videos.length}개 발견`);
    } catch (err) {
      console.error(`  영상 검색 실패: ${(err as Error).message}`);
      if ((err as Error).message.includes("403")) {
        console.error("  ⚠️ API 할당 초과 — 중단합니다.");
        saveProgress(progress);
        process.exit(1);
      }
    }

    await sleep(DELAY);

    // 2) 각 영상 → media 저장 + 댓글 수집
    for (const video of videos) {
      const videoUrl = `https://www.youtube.com/watch?v=${video.videoId}`;

      pendingMedia.push({
        parkingLotId: lot.id,
        videoId: video.videoId,
        url: videoUrl,
        title: video.title,
        thumbnailUrl: video.thumbnailUrl,
        description: video.description.slice(0, 500),
      });

      // 댓글 수집
      try {
        const comments = await getComments(video.videoId, COMMENTS_PER_VIDEO);
        progress.totalCommentCalls++;

        for (const comment of comments) {
          const score = scoreComment(comment.text, lot.name);
          if (score < 30) continue; // 주차 무관 댓글 제외

          const sourceId = await hashUrl(`yt-${comment.commentId}`);
          pendingComments.push({
            parkingLotId: lot.id,
            sourceId,
            title: `[YouTube] ${video.title}`.slice(0, 200),
            content: comment.text.slice(0, 1000),
            sourceUrl: videoUrl,
            author: comment.author,
            publishedAt: comment.publishedAt ? comment.publishedAt.slice(0, 10) : null,
            relevanceScore: score,
          });
        }
      } catch (err) {
        // 댓글 비활성화 등 — 무시
        console.log(`  댓글 수집 스킵 (${video.videoId}): ${(err as Error).message.slice(0, 60)}`);
      }

      await sleep(DELAY);
    }

    completedSet.add(lot.id);
    progress.completedIds.push(lot.id);
    processed++;

    // DB flush
    if (pendingMedia.length >= DB_FLUSH_SIZE) {
      flushMediaToDB(pendingMedia, progress);
      pendingMedia = [];
    }
    if (pendingComments.length >= DB_FLUSH_SIZE) {
      flushCommentsToDB(pendingComments, progress);
      pendingComments = [];
    }

    // 진행상황 저장 (5건마다)
    if (processed % 5 === 0) {
      saveProgress(progress);
      console.log(`\n--- 중간 저장: 미디어 ${progress.savedMedia}건, 댓글 ${progress.savedComments}건, API search=${progress.totalSearchCalls} comments=${progress.totalCommentCalls} ---`);
    }
  }

  // 나머지 flush
  flushMediaToDB(pendingMedia, progress);
  flushCommentsToDB(pendingComments, progress);
  saveProgress(progress);

  if (existsSync(TMP_SQL)) unlinkSync(TMP_SQL);

  console.log(`\n✅ 완료!`);
  console.log(`  미디어: ${progress.savedMedia}건`);
  console.log(`  댓글: ${progress.savedComments}건`);
  console.log(`  API: search=${progress.totalSearchCalls}, comments=${progress.totalCommentCalls}`);
  console.log(`  예상 quota 사용: ${progress.totalSearchCalls * 100 + progress.totalCommentCalls} / 10,000 units`);
}

main().catch((err) => {
  console.error("\n에러:", err.message);
  process.exit(1);
});
