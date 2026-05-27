/**
 * YouTube 영상 배치 크롤러 (Workers Cron용)
 *
 * 대상: is_curated=1 OR total_spaces>=200 (큐레이션 + 중대형 lot)
 * naver/ddg와 동일한 last_run_at 기반 우선순위 큐 + raw 파이프라인 사용.
 *
 * 데이터 흐름:
 *   searchVideos → web_sources_raw (source='youtube_video', filter_passed=null)
 *   → ai-filter → match-to-lots → web_sources + parking_media 노출
 *
 * Quota:
 *   YouTube Data API = 10,000 units/day
 *   search.list = 100 units/call → BATCH_SIZE 4 × 24h = 9,600 units (안전선)
 *
 * 영상 AI 요약은 별도 이슈로 미룸 (자막 fetch 도입 필요).
 */
import { extractRegion, hashUrl, stripHtml } from './lib/scoring'

const BATCH_SIZE = 4 // search 100 units × 4 × 24h = 9,600 units/day (10K quota 안전선)
const RECRAWL_DAYS = 30
const DELAY = 500
const VIDEOS_PER_LOT = 3

const YT_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search'
const YT_VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos'

interface YTSearchItem {
  id: { videoId: string }
  snippet: {
    title: string
    description: string
    publishedAt?: string
    channelTitle?: string
  }
}

interface YTVideoDetail {
  id: string
  snippet: {
    title: string
    description: string
    publishedAt?: string
    channelTitle?: string
    tags?: string[]
  }
}

interface LotRow {
  id: string
  name: string
  address: string
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

/**
 * videos.list로 full description + tags 조회 (1 unit/call, batch 최대 50개).
 * search.list가 truncated description만 주는 것을 보완.
 */
async function fetchVideoDetails(
  videoIds: string[],
  apiKey: string,
): Promise<Map<string, YTVideoDetail>> {
  const result = new Map<string, YTVideoDetail>()
  if (videoIds.length === 0) return result

  // 50개씩 batch
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50)
    const params = new URLSearchParams({
      part: 'snippet',
      id: batch.join(','),
      key: apiKey,
    })
    const res = await fetch(`${YT_VIDEOS_URL}?${params}`)
    if (!res.ok) throw new Error(`YouTube Videos ${res.status}: ${await res.text()}`)
    const data = (await res.json()) as { items: YTVideoDetail[] }
    for (const item of data.items ?? []) {
      result.set(item.id, item)
    }
  }
  return result
}

// ── 우선순위 큐 (naver/ddg와 동일 패턴) ──

async function selectPriorityLots(db: D1Database, limit: number): Promise<LotRow[]> {
  const rows = await db
    .prepare(
      `SELECT p.id, p.name, p.address
       FROM parking_lots p
       LEFT JOIN crawl_progress cp
         ON cp.crawler_id = 'youtube_lot:' || p.id
       WHERE
         (p.is_curated = 1 OR p.total_spaces >= 200)
         AND (cp.last_run_at IS NULL
              OR julianday('now') - julianday(cp.last_run_at) > ?1)
       ORDER BY
         cp.last_run_at ASC NULLS FIRST,
         p.id
       LIMIT ?2`,
    )
    .bind(RECRAWL_DAYS, limit)
    .all<LotRow>()

  return rows.results ?? []
}

export async function runYoutubeBatch(
  db: D1Database,
  env: { YOUTUBE_API_KEY: string },
): Promise<{ processed: number; savedMedia: number; savedComments: number; done: boolean }> {
  const lots = await selectPriorityLots(db, BATCH_SIZE)

  if (lots.length === 0) {
    return { processed: 0, savedMedia: 0, savedComments: 0, done: true }
  }

  let savedMedia = 0
  const rawInserts: D1PreparedStatement[] = []
  const progressBatch: D1PreparedStatement[] = []
  let quotaExhausted = false

  // 1차: 모든 lot의 search 결과 수집
  const searchResults: Array<{ lot: LotRow; videos: YTSearchItem[] }> = []
  for (const lot of lots) {
    if (quotaExhausted) break

    const region = extractRegion(lot.address)
    const query = `${lot.name} ${region} 주차`.trim()

    try {
      const videos = await searchVideos(query, VIDEOS_PER_LOT, env.YOUTUBE_API_KEY)
      searchResults.push({ lot, videos })
    } catch (err) {
      if ((err as Error).message.includes('403')) {
        quotaExhausted = true
        break
      }
      // 그 외 에러: 해당 lot 스킵, progress 갱신
      progressBatch.push(
        db
          .prepare(
            `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
             VALUES (?1, ?2, 0, datetime('now'))
             ON CONFLICT(crawler_id) DO UPDATE SET last_run_at = datetime('now')`,
          )
          .bind(`youtube_lot:${lot.id}`, lot.id),
      )
    }

    await new Promise((r) => setTimeout(r, DELAY))
  }

  // 2차: 모든 videoId 모아서 videos.list 1회 batch 호출 (full description + tags)
  const allVideoIds = searchResults.flatMap(({ videos }) => videos.map((v) => v.id.videoId))
  let videoDetails: Map<string, YTVideoDetail> = new Map()
  if (allVideoIds.length > 0 && !quotaExhausted) {
    try {
      videoDetails = await fetchVideoDetails(allVideoIds, env.YOUTUBE_API_KEY)
    } catch (err) {
      // videos.list 실패해도 search.list 결과만으로 진행 (description truncated 상태)
      console.log(`[youtube] videos.list error: ${(err as Error).message}`)
    }
  }

  // 3차: raw 적재
  for (const { lot, videos } of searchResults) {
    let lotSaved = 0
    for (const video of videos) {
      const videoUrl = `https://www.youtube.com/watch?v=${video.id.videoId}`
      const sourceId = await hashUrl(videoUrl)

      // videos.list 우선, 없으면 search snippet fallback
      const detail = videoDetails.get(video.id.videoId)
      const title = stripHtml(detail?.snippet.title ?? video.snippet.title)
      const description = stripHtml(detail?.snippet.description ?? video.snippet.description).slice(
        0,
        5000,
      )
      const tags = detail?.snippet.tags?.join(', ') ?? ''
      const channel = detail?.snippet.channelTitle ?? video.snippet.channelTitle ?? null
      const publishedAt =
        (detail?.snippet.publishedAt ?? video.snippet.publishedAt)?.slice(0, 10) ?? null

      // full_text: title + description + tags 합본 (검증 컨텍스트)
      const fullTextParts = [title, description, tags ? `Tags: ${tags}` : '']
        .filter(Boolean)
        .join('\n\n')

      rawInserts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO web_sources_raw
               (source, source_id, source_url, title, content, author, published_at,
                full_text, full_text_status, full_text_fetched_at, search_lot_hint)
             VALUES ('youtube_video', ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'ok', datetime('now'), ?8)`,
          )
          .bind(
            sourceId,
            videoUrl,
            title.slice(0, 200),
            description.slice(0, 1000),
            channel,
            publishedAt,
            fullTextParts,
            lot.id,
          ),
      )
      lotSaved++
    }

    savedMedia += lotSaved

    progressBatch.push(
      db
        .prepare(
          `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
           VALUES (?1, ?2, ?3, datetime('now'))
           ON CONFLICT(crawler_id) DO UPDATE SET
             completed_count = completed_count + ?3, last_run_at = datetime('now')`,
        )
        .bind(`youtube_lot:${lot.id}`, lot.id, lotSaved),
    )
  }

  // D1 batch 한도: 최대 1,000 statements
  const D1_BATCH_LIMIT = 500
  for (let i = 0; i < rawInserts.length; i += D1_BATCH_LIMIT) {
    await db.batch(rawInserts.slice(i, i + D1_BATCH_LIMIT))
  }
  if (progressBatch.length > 0) {
    await db.batch(progressBatch)
  }

  // 전체 진행 상태
  await db
    .prepare(
      `INSERT INTO crawl_progress (crawler_id, last_parking_lot_id, completed_count, last_run_at)
       VALUES ('youtube', '', ?1, datetime('now'))
       ON CONFLICT(crawler_id) DO UPDATE SET
         completed_count = completed_count + ?1, last_run_at = datetime('now')`,
    )
    .bind(lots.length)
    .run()

  return {
    processed: lots.length,
    savedMedia,
    savedComments: 0,
    done: lots.length < BATCH_SIZE,
  }
}
