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

import { bumpQueue, RECRAWL_DAYS, selectFromQueue } from './lib/crawl-queue'
import { extractRegion, hashUrl, isGenericName, stripHtml } from './lib/scoring'

const BATCH_SIZE = 4 // search 100 units × 4 × 24h = 9,600 units/day (10K quota 안전선)
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
  type: string | null
}

/**
 * 유튜브 검색 대상으로 삼을 가치가 있는 주차장인가.
 *
 * search.list 는 호출당 100유닛이라 크롤러 중 가장 비싸다. 그런데 2026-09-10 실측 결과
 * 검증을 통과해 parking_media 에 남은 영상 211건의 lot type 은 **노외 195 / 부설 16 / 노상 0** 이다.
 * 노상(5,316곳)은 한 건도 없다 — 길가 주차구획을 다룬 영상은 사실상 존재하지 않는다.
 *
 * 이름이 일반명인 경우도 마찬가지다. naver/ddg/brave 는 이미 isGenericName 으로 걸러왔는데
 * 유튜브만 이 가드가 빠져 있었다. 실제로 "수주", "삼정3호" 같은 공공데이터 이름으로 검색하면
 * 신축빌라 분양 광고가 돌아온다 (검증 샤드 01 에서 97건 중 70건이 부동산 광고).
 */
function isWorthSearching(lot: LotRow): boolean {
  if (lot.type === '노상') return false
  if (isGenericName(lot.name)) return false
  return true
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

/**
 * 선정 결과에서 검색 가치가 없는 lot 을 걸러낸 목록과, 걸러진 목록을 함께 돌려준다.
 *
 * BATCH_SIZE 가 4뿐이라 걸러낸 만큼을 그냥 버리면 한 사이클이 통째로 비어버린다.
 * 그래서 넉넉히(OVERSELECT 배) 뽑아서 거른 뒤 앞에서 limit 개만 쓴다.
 * 걸러진 lot 도 next_at 은 미뤄야 다음 사이클에 같은 것들이 또 앞을 막지 않는다.
 */
const OVERSELECT = 6

async function selectPriorityLots(
  db: D1Database,
  limit: number,
): Promise<{ lots: LotRow[]; skipped: LotRow[] }> {
  // crawl_queue 인덱스 조회로 위임 (0052). 과거에는 parking_lots 31,994행을 매번
  // 스캔했다 — ORDER BY 1순위가 LEFT JOIN 된 reliability 라 인덱스 불가였다.
  const candidates = await selectFromQueue(db, 'youtube', limit * OVERSELECT)
  const lots: LotRow[] = []
  const skipped: LotRow[] = []
  for (const lot of candidates) {
    if (lots.length >= limit) break
    if (isWorthSearching(lot)) lots.push(lot)
    else skipped.push(lot)
  }
  return { lots, skipped }
}

export async function runYoutubeBatch(
  db: D1Database,
  env: { YOUTUBE_API_KEY: string },
): Promise<{ processed: number; savedMedia: number; savedComments: number; done: boolean }> {
  const { lots, skipped } = await selectPriorityLots(db, BATCH_SIZE)

  let savedMedia = 0
  const rawInserts: D1PreparedStatement[] = []
  const progressBatch: D1PreparedStatement[] = []
  let quotaExhausted = false

  // 검색 가치가 없다고 판단한 lot 은 쿼터를 쓰지 않고 다음 주기로 미룬다.
  // 미루지 않으면 같은 lot 들이 매 사이클 큐 앞을 계속 막는다.
  for (const lot of skipped) {
    progressBatch.push(bumpQueue(db, 'youtube', lot.id, RECRAWL_DAYS))
  }

  if (lots.length === 0) {
    if (progressBatch.length > 0) await db.batch(progressBatch)
    return { processed: 0, savedMedia: 0, savedComments: 0, done: skipped.length === 0 }
  }

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
        // crawl_queue 의 next_at 도 함께 미룬다 (0052)
        bumpQueue(db, 'youtube', lot.id, RECRAWL_DAYS),
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

      // 본문은 web_sources_raw_body에 분리 저장 (0048).
      // 배치 실행이라 auto-generated id를 알 수 없으므로 source_id로 되찾아 넣는다.
      // 중복 판정은 seen_sources 로 한다 (0050). web_sources_raw 는 처리 완료 후
      // 삭제되는 임시 데이터라 UNIQUE 제약만으로는 재크롤을 막지 못한다.
      rawInserts.push(
        db
          .prepare(
            `INSERT OR IGNORE INTO web_sources_raw
               (source, source_id, source_url, title, content, author, published_at,
                full_text_status, full_text_fetched_at, search_lot_hint)
             SELECT 'youtube_video', ?1, ?2, ?3, ?4, ?5, ?6, 'ok', datetime('now'), ?7
              WHERE NOT EXISTS (
                SELECT 1 FROM seen_sources
                 WHERE source = 'youtube_video' AND source_id = ?1)`,
          )
          .bind(
            sourceId,
            videoUrl,
            title.slice(0, 200),
            description.slice(0, 1000),
            channel,
            publishedAt,
            lot.id,
          ),
        db
          .prepare(
            `INSERT OR REPLACE INTO web_sources_raw_body (raw_id, body)
             SELECT id, ?2 FROM web_sources_raw
              WHERE source = 'youtube_video' AND source_id = ?1`,
          )
          .bind(sourceId, fullTextParts),
        db
          .prepare(
            `INSERT OR IGNORE INTO seen_sources (source, source_id) VALUES ('youtube_video', ?1)`,
          )
          .bind(sourceId),
      )
      lotSaved++
    }

    savedMedia += lotSaved

    progressBatch.push(
      // crawl_queue 의 next_at 도 함께 미룬다 (0052)
      bumpQueue(db, 'youtube', lot.id, RECRAWL_DAYS),
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
    // 걸러낸 lot 이 있었다면 큐는 아직 안 빈 것이다 — lots 가 모자란 건 큐가 말라서가 아니다.
    done: lots.length < BATCH_SIZE && skipped.length === 0,
  }
}
