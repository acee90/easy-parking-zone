/**
 * YouTube 영상/댓글 배치 크롤러 (Workers Cron용)
 *
 * D1 바인딩 직접 사용, 파일시스템 의존 없음.
 * curated 주차장 대상, 한 번에 BATCH_SIZE개 처리.
 */
import { extractRegion, hashUrl, scoreYoutubeComment } from './lib/scoring'

const BATCH_SIZE = 5 // API 쿼터 고려 (search=100 units × 5 = 500 units/실행)
const DELAY = 500
const VIDEOS_PER_LOT = 3
const COMMENTS_PER_VIDEO = 10
const COMMENT_SCORE_THRESHOLD = 30

const YT_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search'
const YT_COMMENTS_URL = 'https://www.googleapis.com/youtube/v3/commentThreads'

interface YTSearchItem {
  id: { videoId: string }
  snippet: { title: string; description: string; thumbnails: { medium: { url: string } } }
}

interface YTCommentItem {
  id: string
  snippet: {
    topLevelComment: {
      snippet: { textDisplay: string; authorDisplayName: string; publishedAt: string }
    }
  }
}

async function searchVideos(query: string, maxResults: number, apiKey: string) {
  const params = new URLSearchParams({
    part: 'snippet',
    q: query,
    type: 'video',
    maxResults: String(maxResults),
    key: apiKey,
    relevanceLanguage: 'ko',
  })
  const res = await fetch(`${YT_SEARCH_URL}?${params}`)
  if (!res.ok) throw new Error(`YouTube Search ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { items: YTSearchItem[] }
  return data.items ?? []
}

async function getComments(videoId: string, maxResults: number, apiKey: string) {
  const params = new URLSearchParams({
    part: 'snippet',
    videoId,
    maxResults: String(maxResults),
    order: 'relevance',
    key: apiKey,
  })
  const res = await fetch(`${YT_COMMENTS_URL}?${params}`)
  if (!res.ok) throw new Error(`YouTube Comments ${res.status}`)
  const data = (await res.json()) as { items: YTCommentItem[] }
  return data.items ?? []
}

export async function runYoutubeBatch(
  db: D1Database,
  env: { YOUTUBE_API_KEY: string },
): Promise<{ processed: number; savedMedia: number; savedComments: number; done: boolean }> {
  // 진행 상태 조회
  const progress = await db
    .prepare(
      "SELECT last_parking_lot_id, completed_count FROM crawl_progress WHERE crawler_id = 'youtube'",
    )
    .first<{ last_parking_lot_id: string | null; completed_count: number }>()

  const cursor = progress?.last_parking_lot_id ?? ''
  const completedCount = progress?.completed_count ?? 0

  // curated 주차장에서 다음 배치
  const lots = await db
    .prepare(
      'SELECT id, name, address FROM parking_lots WHERE is_curated = 1 AND id > ?1 ORDER BY id LIMIT ?2',
    )
    .bind(cursor, BATCH_SIZE)
    .all<{ id: string; name: string; address: string }>()

  if (!lots.results || lots.results.length === 0) {
    return { processed: 0, savedMedia: 0, savedComments: 0, done: true }
  }

  let savedMedia = 0
  let savedComments = 0
  const batch: D1PreparedStatement[] = []

  for (const lot of lots.results) {
    const region = extractRegion(lot.address)
    const query = `${lot.name} ${region} 주차`.trim()

    // 영상 검색
    let videos: YTSearchItem[] = []
    try {
      videos = await searchVideos(query, VIDEOS_PER_LOT, env.YOUTUBE_API_KEY)
    } catch (err) {
      if ((err as Error).message.includes('403')) {
        // 쿼터 초과 — 여기서 중단, 다음 실행에 계속
        break
      }
      continue
    }

    await new Promise((r) => setTimeout(r, DELAY))

    for (const video of videos) {
      const videoUrl = `https://www.youtube.com/watch?v=${video.id.videoId}`

      // 미디어 저장
      batch.push(
        db
          .prepare(
            "INSERT OR IGNORE INTO parking_media (parking_lot_id, media_type, url, title, thumbnail_url, description) VALUES (?1, 'youtube', ?2, ?3, ?4, ?5)",
          )
          .bind(
            lot.id,
            videoUrl,
            video.snippet.title,
            video.snippet.thumbnails.medium.url,
            video.snippet.description.slice(0, 500),
          ),
      )
      savedMedia++

      // 댓글 수집
      try {
        const comments = await getComments(
          video.id.videoId,
          COMMENTS_PER_VIDEO,
          env.YOUTUBE_API_KEY,
        )
        for (const c of comments) {
          const text = c.snippet.topLevelComment.snippet.textDisplay
          const score = scoreYoutubeComment(text, lot.name)
          if (score < COMMENT_SCORE_THRESHOLD) continue

          const sourceId = await hashUrl(`yt-${c.id}`)
          batch.push(
            db
              .prepare(
                "INSERT OR IGNORE INTO web_sources_raw (source, source_id, source_url, title, content, author, published_at) VALUES ('youtube_comment', ?1, ?2, ?3, ?4, ?5, ?6)",
              )
              .bind(
                sourceId,
                videoUrl,
                `[YouTube] ${video.snippet.title}`.slice(0, 200),
                text.slice(0, 1000),
                c.snippet.topLevelComment.snippet.authorDisplayName,
                c.snippet.topLevelComment.snippet.publishedAt?.slice(0, 10) ?? null,
              ),
          )
          savedComments++
        }
      } catch {
        /* 댓글 비활성화 등 — 무시 */
      }

      await new Promise((r) => setTimeout(r, DELAY))
    }
  }

  // 배치 실행
  if (batch.length > 0) {
    await db.batch(batch)
  }

  // 진행 상태 업데이트
  const lastId = lots.results[lots.results.length - 1].id
  const newCount = completedCount + lots.results.length

  await db
    .prepare(
      `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
       VALUES ('youtube', ?1, ?2, datetime('now'))
       ON CONFLICT(crawler_id) DO UPDATE SET
         last_parking_lot_id = ?1, completed_count = ?2, last_run_at = datetime('now')`,
    )
    .bind(lastId, newCount)
    .run()

  return { processed: lots.results.length, savedMedia, savedComments, done: false }
}
