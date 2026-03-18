/**
 * YouTube 영상/댓글 수집
 *
 * 모드:
 *   기본: curated 주차장(is_curated=1)만 크롤링
 *   --expand: 우선순위 기반 확장 크롤링 (대형/텍스트풍부 주차장)
 *
 * - 영상 URL/썸네일 → parking_media 테이블
 * - 주차 관련 댓글 → web_sources 테이블 (source='youtube_comment')
 * - 진행상황을 scripts/youtube-progress*.json에 저장 → 중단 후 재개 가능
 *
 * 사용법:
 *   bun run scripts/crawl-youtube.ts --remote
 *   bun run scripts/crawl-youtube.ts --remote --expand
 *
 * API 비용:
 *   search.list = 100 units, commentThreads.list = 1 unit
 *   무료 할당 10,000 units/일 → 주차장 ~90개 처리 가능
 */
import { existsSync, unlinkSync } from "fs";
import { resolve } from "path";
import { searchVideos, getComments, type YouTubeVideo } from "./lib/youtube-api";
import { hashUrl } from "./lib/naver-api";
import { d1Query, isRemote } from "./lib/d1";
import { extractRegion, sleep } from "./lib/geo";
import { loadProgress, saveProgress } from "./lib/progress";
import { buildInsert, flushStatements } from "./lib/sql-flush";

// --- Config ---
const EXPAND_MODE = process.argv.includes("--expand");

const DELAY = 500;
const VIDEOS_PER_LOT = 3;
const COMMENTS_PER_VIDEO = 10;
const DB_FLUSH_SIZE = 30;

const progressFile = EXPAND_MODE ? "youtube-expand-progress.json" : "youtube-progress.json";
const PROGRESS_JSON = resolve(import.meta.dir, progressFile);
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

const MEDIA_COLUMNS = ["parking_lot_id", "media_type", "url", "title", "thumbnail_url", "description"];
const REVIEW_COLUMNS = [
  "parking_lot_id", "source", "source_id", "title", "content",
  "source_url", "author", "published_at", "relevance_score",
];

/** 댓글이 주차와 관련있는지 점수 매기기 (0-100) */
function scoreComment(text: string, parkingName: string): number {
  let score = 0;
  const t = text.toLowerCase();

  const parkingKeywords = ["주차", "parking", "차", "운전"];
  const difficultyKeywords = ["좁", "무서", "힘들", "긁", "어려", "공포", "골뱅이", "나선", "경사", "회전", "기둥"];
  const positiveKeywords = ["넓", "쉬", "편", "여유", "추천"];

  if (parkingKeywords.some((kw) => t.includes(kw))) score += 30;
  if (difficultyKeywords.some((kw) => t.includes(kw))) score += 40;
  if (positiveKeywords.some((kw) => t.includes(kw))) score += 20;

  const nameWords = parkingName
    .replace(/주차장|주차/g, "")
    .split(/\s+/)
    .filter((w) => w.length >= 2);
  if (nameWords.some((kw) => t.includes(kw.toLowerCase()))) score += 20;

  if (text.length < 10) score -= 20;

  return Math.max(0, Math.min(100, score));
}

// --- DB helpers ---
function flushMediaToDB(items: PendingMedia[], progress: Progress) {
  if (items.length === 0) return;

  const stmts = items.map((m) =>
    buildInsert("parking_media", MEDIA_COLUMNS, [
      m.parkingLotId, "youtube", m.url, m.title, m.thumbnailUrl, m.description,
    ])
  );

  flushStatements(TMP_SQL, stmts);
  progress.savedMedia += items.length;
}

function flushCommentsToDB(items: PendingComment[], progress: Progress) {
  if (items.length === 0) return;

  const stmts = items.map((c) =>
    buildInsert("web_sources", REVIEW_COLUMNS, [
      c.parkingLotId, "youtube_comment", c.sourceId, c.title, c.content,
      c.sourceUrl, c.author, c.publishedAt, c.relevanceScore,
    ])
  );

  flushStatements(TMP_SQL, stmts);
  progress.savedComments += items.length;
}

// --- Main ---
async function main() {
  if (!process.env.YOUTUBE_API_KEY) {
    console.error("YOUTUBE_API_KEY가 .env에 설정되지 않았습니다.");
    console.error("Google Cloud Console → YouTube Data API v3 → API 키 발급 필요");
    process.exit(1);
  }

  const progress = loadProgress<Progress>(PROGRESS_JSON, {
    completedIds: [],
    totalSearchCalls: 0,
    totalCommentCalls: 0,
    savedMedia: 0,
    savedComments: 0,
    startedAt: "",
    lastUpdatedAt: "",
  });
  const completedSet = new Set(progress.completedIds);

  if (isRemote) console.log("🌐 리모트 D1 모드");
  console.log(`모드: ${EXPAND_MODE ? "확장 (우선순위 기반)" : "큐레이션"}\n`);

  let lots: ParkingRow[];
  if (EXPAND_MODE) {
    console.log("우선순위 기반 타겟 주차장 조회 중...");
    // 우선순위: 1) 큐레이션 미완료 → 2) 리뷰 있음 → 3) 텍스트소스 풍부 → 4) 대형 주차장
    lots = d1Query(`
      SELECT id, name, address, COALESCE(curation_tag, '') as curation_tag FROM (
        SELECT p.id, p.name, p.address, p.curation_tag, 1 as priority
        FROM parking_lots p
        WHERE p.is_curated = 1
        AND p.id NOT IN (SELECT DISTINCT parking_lot_id FROM parking_media)

        UNION ALL

        SELECT p.id, p.name, p.address, p.curation_tag, 2 as priority
        FROM parking_lots p
        JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE (s.user_review_count > 0 OR s.community_count > 0)
        AND p.is_curated = 0
        AND p.id NOT IN (SELECT DISTINCT parking_lot_id FROM parking_media)

        UNION ALL

        SELECT p.id, p.name, p.address, p.curation_tag, 3 as priority
        FROM parking_lots p
        JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE s.text_source_count >= 3
        AND p.is_curated = 0
        AND COALESCE(s.user_review_count, 0) = 0 AND COALESCE(s.community_count, 0) = 0
        AND p.id NOT IN (SELECT DISTINCT parking_lot_id FROM parking_media)

        UNION ALL

        SELECT p.id, p.name, p.address, p.curation_tag, 4 as priority
        FROM parking_lots p
        WHERE p.total_spaces >= 100
        AND p.is_curated = 0
        AND p.id NOT IN (SELECT parking_lot_id FROM parking_lot_stats WHERE text_source_count >= 3)
        AND p.id NOT IN (SELECT DISTINCT parking_lot_id FROM parking_media)
      )
      GROUP BY id
      ORDER BY MIN(priority), name
    `);
  } else {
    console.log("큐레이션된 주차장 조회 중...");
    lots = d1Query("SELECT id, name, address, curation_tag FROM parking_lots WHERE is_curated = 1");
  }

  const remaining = lots.filter((l) => !completedSet.has(l.id));
  console.log(`총 ${lots.length}개 타겟, ${completedSet.size}개 완료됨, ${remaining.length}개 남음`);

  let pendingMedia: PendingMedia[] = [];
  let pendingComments: PendingComment[] = [];
  let processed = 0;

  for (const lot of remaining) {
    const region = extractRegion(lot.address);
    const query = `${lot.name} ${region} 주차`.trim();

    console.log(`\n[${processed + 1}/${remaining.length}] ${lot.name} (${lot.curation_tag || "-"})`);
    console.log(`  검색: "${query}"`);

    let videos: YouTubeVideo[] = [];
    try {
      videos = await searchVideos(query, VIDEOS_PER_LOT);
      progress.totalSearchCalls++;
      console.log(`  영상 ${videos.length}개 발견`);
    } catch (err) {
      console.error(`  영상 검색 실패: ${(err as Error).message}`);
      if ((err as Error).message.includes("403")) {
        console.error("  ⚠️ API 할당 초과 — 중단합니다.");
        saveProgress(PROGRESS_JSON, progress);
        process.exit(1);
      }
    }

    await sleep(DELAY);

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

      try {
        const comments = await getComments(video.videoId, COMMENTS_PER_VIDEO);
        progress.totalCommentCalls++;

        for (const comment of comments) {
          const score = scoreComment(comment.text, lot.name);
          if (score < 30) continue;

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
        console.log(`  댓글 수집 스킵 (${video.videoId}): ${(err as Error).message.slice(0, 60)}`);
      }

      await sleep(DELAY);
    }

    completedSet.add(lot.id);
    progress.completedIds.push(lot.id);
    processed++;

    if (pendingMedia.length >= DB_FLUSH_SIZE) {
      flushMediaToDB(pendingMedia, progress);
      pendingMedia = [];
    }
    if (pendingComments.length >= DB_FLUSH_SIZE) {
      flushCommentsToDB(pendingComments, progress);
      pendingComments = [];
    }

    if (processed % 5 === 0) {
      saveProgress(PROGRESS_JSON, progress);
      const quotaUsed = progress.totalSearchCalls * 100 + progress.totalCommentCalls;
      console.log(`\n--- 중간 저장: 미디어 ${progress.savedMedia}건, 댓글 ${progress.savedComments}건, quota ~${quotaUsed}/10,000 ---`);
    }
  }

  flushMediaToDB(pendingMedia, progress);
  flushCommentsToDB(pendingComments, progress);
  saveProgress(PROGRESS_JSON, progress);

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
