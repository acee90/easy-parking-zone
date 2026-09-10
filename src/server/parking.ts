import { env } from 'cloudflare:workers'
import { createServerFn } from '@tanstack/react-start'
import { and, count, desc, eq, sql } from 'drizzle-orm'
import { getDb, schema } from '@/db'
import {
  coreQueryString,
  type KakaoPlaceDocument,
  mergePlaces,
  normalizeSearchQuery,
  parseKakaoPlaces,
} from '@/lib/search-query'
import { AGGREGATOR_DOMAINS, extractHost } from '@/server/crawlers/lib/aggregator-domains'
import {
  normalizeDifficultyKeywords,
  parseKeywordJson,
} from '@/server/crawlers/lib/difficulty-tags'
import { mergeFieldEdits } from '@/server/field-edits-merge'
import { checkRateLimit } from '@/server/rate-limit'
import type { BlogPost, MapBounds, NearbyPlaceInfo, ParkingFilters, Place } from '@/types/parking'
import {
  type BlogPostRow,
  buildFilterClauses,
  type MediaRow,
  type ParkingLotRow,
  rowToBlogPost,
  rowToMedia,
  rowToParkingLot,
} from './transforms'

/** 사이트 전체 통계 (1시간 Cache API 캐싱) */
export const fetchSiteStats = createServerFn({ method: 'GET' }).handler(async () => {
  const CACHE_KEY = 'https://easy-parking.xyz/__internal/site-stats'
  const CACHE_TTL = 60 * 60 // 1시간

  const cache = typeof caches !== 'undefined' ? await caches.open('site-stats') : null
  if (cache) {
    const cached = await cache.match(CACHE_KEY)
    if (cached) return cached.json()
  }

  const db = getDb()
  const statsRow = (await db.get(
    sql.raw(`SELECT
      (SELECT COUNT(*) FROM parking_lots) as parking_lots,
      (SELECT COUNT(*) FROM user_reviews) as reviews,
      (SELECT COUNT(*) FROM parking_media) + (SELECT COUNT(*) FROM web_sources) as media_posts`),
  )) as { parking_lots: number; reviews: number; media_posts: number } | null

  const stats = {
    parkingLots: statsRow?.parking_lots ?? 0,
    reviews: statsRow?.reviews ?? 0,
    mediaPosts: statsRow?.media_posts ?? 0,
  }

  if (cache) {
    await cache.put(
      CACHE_KEY,
      new Response(JSON.stringify(stats), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `public, max-age=${CACHE_TTL}`,
        },
      }),
    )
  }

  return stats
})

/** bounds 내 주차장 목록 조회 — 동적 WHERE + JOIN이 복잡하여 raw SQL 유지 */
export const fetchParkingLots = createServerFn({ method: 'GET' })
  .inputValidator(
    (
      input: MapBounds & { limit?: number; filters?: ParkingFilters },
    ): MapBounds & { limit?: number; filters?: ParkingFilters } => input,
  )
  .handler(async ({ data }) => {
    const db = getDb()
    const limit = data.limit ?? 200
    const { where } = buildFilterClauses(data.filters)

    const rows = await db.all(
      sql.raw(
        `SELECT p.*,
          s.final_score as avg_score,
          COALESCE(s.review_count, 0) as review_count,
          s.reliability,
          p.verified_source
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE p.lat BETWEEN ${data.south} AND ${data.north}
          AND p.lng BETWEEN ${data.west} AND ${data.east}${where}
        LIMIT ${limit}`,
      ),
    )

    return (rows as unknown as ParkingLotRow[]).map(rowToParkingLot)
  })

/** 전체 주차장 경량 데이터 (SuperCluster용, CDN 캐시) */
export interface ParkingPoint {
  id: string
  lat: number
  lng: number
  score: number | null
  name: string
}

export const fetchAllParkingPoints = createServerFn({ method: 'GET' }).handler(
  async ({ request }): Promise<ParkingPoint[]> => {
    await checkRateLimit(env.RATE_LIMITER_POINTS, request)

    const db = getDb()

    // 캐시 키에 lot 갱신 fingerprint 포함 → INSERT/UPDATE 시 자동 무효화
    // (COUNT는 row 추가/삭제 감지, MAX(updated_at)는 row 수정 감지)
    const versionRow = (await db.get(
      sql.raw(`SELECT COUNT(*) as n, COALESCE(MAX(updated_at), '') as ts FROM parking_lots`),
    )) as { n: number; ts: string } | undefined
    const version = `${versionRow?.n ?? 0}-${versionRow?.ts ?? ''}`
    const CACHE_KEY = `https://cache.internal/parking-points-v2?v=${encodeURIComponent(version)}`
    const CACHE_TTL = 3600 // 1시간 (fingerprint 변동 없으면 그대로 유지)

    const cache = typeof caches !== 'undefined' ? await caches.open('parking-points') : null
    if (cache) {
      const cached = await cache.match(CACHE_KEY)
      if (cached) return cached.json()
    }

    const rows = await db.all(
      sql.raw(
        `SELECT p.id, p.lat, p.lng, p.name, s.final_score as score
         FROM parking_lots p
         LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id`,
      ),
    )

    const result = rows as unknown as ParkingPoint[]

    if (cache) {
      cache
        .put(
          CACHE_KEY,
          new Response(JSON.stringify(result), {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': `public, max-age=${CACHE_TTL}`,
            },
          }),
        )
        .catch(() => {}) // 캐시 쓰기 실패는 무시
    }

    return result
  },
)

/** 이름/주소 LIKE 검색 — raw SQL (동적 WHERE + JOIN) */
export const searchParkingLots = createServerFn({ method: 'GET' })
  .inputValidator((input: { query: string }): { query: string } => input)
  .handler(async ({ data }) => {
    const db = getDb()

    // 단어 분리: "스타필드 위례" → 각 단어가 모두 포함되어야 매칭
    // "석촌역 근처 주차장"처럼 탐색 표현이 붙으면 핵심 단어만 남긴다
    const { original, core } = normalizeSearchQuery(data.query)
    if (core.length === 0) return []

    const wordCondition = (w: string) => {
      const like = `%${w}%`
      return sql`(p.name LIKE ${like} OR p.address LIKE ${like} OR p.poi_tags LIKE ${like})`
    }
    const coreCondition = sql.join(core.map(wordCondition), sql` AND `)
    const originalCondition = sql.join(original.map(wordCondition), sql` AND `)

    // core 조건은 original 조건보다 느슨하므로(original ⊆ core) 기존 결과는
    // 그대로 살아남고, 원본 검색어까지 만족하는 행이 앞에 온다
    const rows = await db.all(
      sql`SELECT p.*,
          s.final_score as avg_score,
          COALESCE(s.review_count, 0) as review_count,
          s.reliability
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE ${coreCondition}
        ORDER BY CASE WHEN ${originalCondition} THEN 0 ELSE 1 END
        LIMIT 20`,
    )

    return (rows as unknown as ParkingLotRow[]).map(rowToParkingLot)
  })

/** 단일 주차장 상세 조회 (위키 페이지용) */
export const fetchParkingDetail = createServerFn({ method: 'GET' })
  .inputValidator((input: { id: string }): { id: string } => {
    if (!input.id || typeof input.id !== 'string' || input.id.length > 64)
      throw new Error('invalid id')
    return input
  })
  .handler(async ({ data, request }) => {
    await checkRateLimit(env.RATE_LIMITER_DETAIL, request)

    const db = getDb()
    const rows = await db.all(
      sql`SELECT p.*,
          s.final_score as avg_score,
          COALESCE(s.review_count, 0) as review_count,
          s.reliability,
          s.ai_summary,
          s.ai_summary_updated_at,
          s.ai_tip_pricing,
          s.ai_tip_visit,
          s.ai_tip_alternative
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE p.id = ${data.id}`,
    )
    if (rows.length === 0) return null
    const base = rowToParkingLot(rows[0] as unknown as ParkingLotRow)

    // 유저 제보를 원본 위에 얹는다. 어느 칸이 제보값인지는 `fieldSources` 가 말한다 —
    // 배지·구조화 데이터·색인 판정이 모두 그걸 보고 갈린다
    const { lot, fieldSources } = await mergeFieldEdits(base)
    return { ...lot, fieldSources }
  })

/** 근처 주차장 조회 (위키 페이지용) */
export const fetchNearbyParkingLots = createServerFn({ method: 'GET' })
  .inputValidator(
    (input: {
      lat: number
      lng: number
      excludeId: string
      limit?: number
    }): { lat: number; lng: number; excludeId: string; limit?: number } => {
      if (!Number.isFinite(input.lat) || Math.abs(input.lat) > 90) throw new Error('invalid lat')
      if (!Number.isFinite(input.lng) || Math.abs(input.lng) > 180) throw new Error('invalid lng')
      if (input.limit !== undefined && (input.limit < 1 || input.limit > 50))
        throw new Error('invalid limit')
      return input
    },
  )
  .handler(async ({ data }) => {
    const db = getDb()
    const lim = data.limit ?? 5
    const delta = 0.01 // ~1km 반경
    const south = data.lat - delta
    const north = data.lat + delta
    const west = data.lng - delta
    const east = data.lng + delta
    const rows = await db.all(
      sql`SELECT p.*,
          s.final_score as avg_score,
          COALESCE(s.review_count, 0) as review_count,
          s.reliability
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE p.lat BETWEEN ${south} AND ${north}
          AND p.lng BETWEEN ${west} AND ${east}
          AND p.id != ${data.excludeId}
        ORDER BY ABS(p.lat - ${data.lat}) + ABS(p.lng - ${data.lng})
        LIMIT ${lim}`,
    )
    return (rows as unknown as ParkingLotRow[]).map(rowToParkingLot)
  })

/** 위키 상세 내부 링크용 관련 주차장 */
export const fetchRelatedParkingLots = createServerFn({ method: 'GET' })
  .inputValidator(
    (input: {
      lat: number
      lng: number
      address: string
      excludeId: string
      limit?: number
    }): { lat: number; lng: number; address: string; excludeId: string; limit?: number } => {
      if (!Number.isFinite(input.lat) || Math.abs(input.lat) > 90) throw new Error('invalid lat')
      if (!Number.isFinite(input.lng) || Math.abs(input.lng) > 180) throw new Error('invalid lng')
      if (!input.address || typeof input.address !== 'string') throw new Error('invalid address')
      if (!input.excludeId || typeof input.excludeId !== 'string')
        throw new Error('invalid excludeId')
      if (input.limit !== undefined && (input.limit < 1 || input.limit > 20))
        throw new Error('invalid limit')
      return input
    },
  )
  .handler(async ({ data }) => {
    const db = getDb()
    const lim = data.limit ?? 8
    const delta = 0.04 // 대략 4km 내외 후보
    const south = data.lat - delta
    const north = data.lat + delta
    const west = data.lng - delta
    const east = data.lng + delta
    const rows = await db.all(
      sql`WITH source_counts AS (
          SELECT
            parking_lot_id,
            COUNT(*) AS web_count,
            SUM(CASE WHEN relevance_score >= 70 THEN 1 ELSE 0 END) AS high_source_count
          FROM web_sources
          GROUP BY parking_lot_id
        )
        SELECT p.*,
          s.final_score as avg_score,
          COALESCE(s.review_count, 0) as review_count,
          s.reliability,
          COALESCE(sc.web_count, 0) as web_count,
          COALESCE(sc.high_source_count, 0) as high_source_count
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        LEFT JOIN source_counts sc ON sc.parking_lot_id = p.id
        WHERE p.id != ${data.excludeId}
          AND p.lat BETWEEN ${south} AND ${north}
          AND p.lng BETWEEN ${west} AND ${east}
        ORDER BY
          ((p.lat - ${data.lat}) * (p.lat - ${data.lat}) + (p.lng - ${data.lng}) * (p.lng - ${data.lng})) ASC,
          COALESCE(sc.web_count, 0) DESC,
          COALESCE(s.review_count, 0) DESC
        LIMIT ${lim}`,
    )

    return (rows as unknown as ParkingLotRow[]).map(rowToParkingLot)
  })

/** 주차장 탭 카운트 (리뷰/블로그/영상) 한번에 조회 */
/**
 * 정보 모음 사이트(경쟁 애그리게이터) 제외 조건.
 *
 * 소급 마킹(filter_passed_v2 = 0)이 끝나기 전에도 즉시 걸리도록 URL 패턴으로도 함께 배제한다.
 * 목록·근거: docs/references/competitors.md
 */
function notAggregator() {
  // 도메인 패턴은 두 가지면 충분하다.
  //   `%//도메인%`  → https://jucha.kr, https://jucha.kr/a, https://jucha.kr?q=1 을 모두 잡는다
  //   `%.도메인%`   → 서브도메인(news.k114.co.kr). 앞의 점 때문에 notjucha.kr 은 안 걸린다
  // 각 조건을 괄호로 싸는 이유: raw sql 조각은 우선순위를 스스로 지키지 못해서,
  // 나중에 이 헬퍼가 or() 안에 들어가면 조용히 다른 뜻이 된다.
  const urlConds = AGGREGATOR_DOMAINS.map(
    (d) => sql`(${schema.webSources.sourceUrl} NOT LIKE ${`%//${d}%`}
      AND ${schema.webSources.sourceUrl} NOT LIKE ${`%.${d}%`})`,
  )
  return and(
    // 소급 마킹이 정본이다. URL 패턴은 마킹 전에 새로 들어온 행을 위한 안전망이다.
    sql`(${schema.webSources.filterPassedV2} IS NULL OR ${schema.webSources.filterPassedV2} != 0)`,
    ...urlConds,
  )
}

export const fetchTabCounts = createServerFn({ method: 'GET' })
  .inputValidator((input: { parkingLotId: string }): { parkingLotId: string } => input)
  .handler(
    async ({
      data,
    }): Promise<{
      reviews: number
      blog: number
      media: number
      realReviews: number
      realReviewScore: number | null
    }> => {
      const db = getDb()
      const [reviews, realReviews, blog, media] = await Promise.all([
        db
          .select({ cnt: count() })
          .from(schema.userReviews)
          .where(eq(schema.userReviews.parkingLotId, data.parkingLotId))
          .get(),
        // 시드 리뷰(is_seed=1, 전체 234건 중 143건)를 뺀 실사용자 리뷰 수.
        // 별점 구조화 데이터는 이 값이 0보다 클 때만 내보낸다.
        db
          .select({
            cnt: count(),
            avg: sql<number | null>`avg(${schema.userReviews.overallScore})`,
          })
          .from(schema.userReviews)
          .where(
            and(
              eq(schema.userReviews.parkingLotId, data.parkingLotId),
              eq(schema.userReviews.isSeed, false),
            ),
          )
          .get(),
        db
          .select({ cnt: count() })
          .from(schema.webSources)
          .where(
            and(
              eq(schema.webSources.parkingLotId, data.parkingLotId),
              sql`${schema.webSources.relevanceScore} >= 40`,
              // 목록(fetchBlogPosts)과 조건이 같아야 한다. 빠지면 배지에 21이라 써놓고
              // 열면 7건만 나오는 식으로 어긋난다.
              notAggregator(),
            ),
          )
          .get(),
        db
          .select({ cnt: count() })
          .from(schema.parkingMedia)
          .where(eq(schema.parkingMedia.parkingLotId, data.parkingLotId))
          .get(),
      ])
      return {
        reviews: reviews?.cnt ?? 0,
        realReviews: realReviews?.cnt ?? 0,
        // 시드를 뺀 실사용자 리뷰만의 평균.
        // `lot.difficulty.score` 는 구조적 추정치라 리뷰가 0건이어도 값이 있다(31,939행, 99.8%).
        // 그것을 '이용자 별점'으로 보여주면 AggregateRating 에서 고쳤던 왜곡을 화면에서 되풀이한다.
        realReviewScore:
          realReviews?.cnt && realReviews.avg != null
            ? Math.round(Number(realReviews.avg) * 10) / 10
            : null,
        blog: blog?.cnt ?? 0,
        media: media?.cnt ?? 0,
      }
    },
  )

/**
 * 웹 후기 분위기 + 자주 나온 말 (2-1 / 2-2)
 *
 * `sentiment_score` 는 이미 1~5 스케일로 저장돼 있다. 새로 만들 필요가 없다.
 * 다만 **이용자가 매긴 별점이 아니라 AI 추정값**이므로 화면에서도 별점처럼 보이면 안 되고
 * schema.org AggregateRating 으로도 내보내지 않는다.
 *
 * 정보 모음 사이트(경쟁 애그리게이터)는 집계에서 뺀다 — 안 그러면 경쟁사 페이지 점수가 평균에 섞인다.
 */
export const fetchWebSentiment = createServerFn({ method: 'GET' })
  .inputValidator((input: { parkingLotId: string }): { parkingLotId: string } => input)
  .handler(
    async ({
      data,
    }): Promise<{
      average: number
      count: number
      buckets: { good: number; neutral: number; bad: number }
      tags: Array<{
        key: string
        label: string
        polarity: 'good' | 'bad' | 'neutral'
        count: number
      }>
    } | null> => {
      const db = getDb()
      const rows = await db
        .select({
          sentiment: schema.webSources.sentimentScore,
          keywords: schema.webSources.aiDifficultyKeywords,
        })
        .from(schema.webSources)
        .where(
          and(
            eq(schema.webSources.parkingLotId, data.parkingLotId),
            sql`${schema.webSources.relevanceScore} >= 40`,
            notAggregator(),
          ),
        )

      const scores = rows
        .map((r) => r.sentiment)
        .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))

      const tags = normalizeDifficultyKeywords(rows.map((r) => parseKeywordJson(r.keywords)))

      if (scores.length === 0 && tags.length === 0) return null

      const count = scores.length
      const average = count > 0 ? scores.reduce((a, b) => a + b, 0) / count : 0
      return {
        average: Math.round(average * 10) / 10,
        count,
        buckets: {
          good: scores.filter((v) => v >= 4).length,
          neutral: scores.filter((v) => v >= 3 && v < 4).length,
          bad: scores.filter((v) => v < 3).length,
        },
        tags: tags.map((t) => ({
          key: t.key,
          label: t.label,
          polarity: t.polarity,
          count: t.count,
        })),
      }
    },
  )

/**
 * 참고한 웹 글 목록 (2-4)
 *
 * 제목·도메인·날짜·링크만 돌려준다. **본문·요약은 담지 않는다** — 화면에 원문을 한 조각도
 * 그리지 않기로 했기 때문이다(저작권 + 긁어온 글 재게시 회피).
 */
export const fetchWebSourceRefs = createServerFn({ method: 'GET' })
  .inputValidator((input: { parkingLotId: string }): { parkingLotId: string } => input)
  .handler(
    async ({
      data,
    }): Promise<{
      sources: Array<{
        id: number
        title: string
        sourceUrl: string
        host: string
        publishedAt?: string
        author?: string
      }>
      excludedCount: number
    }> => {
      const db = getDb()
      const [kept, excluded] = await Promise.all([
        db
          .select({
            id: schema.webSources.id,
            title: schema.webSources.title,
            sourceUrl: schema.webSources.sourceUrl,
            author: schema.webSources.author,
            publishedAt: schema.webSources.publishedAt,
            sentiment: schema.webSources.sentimentScore,
          })
          .from(schema.webSources)
          .where(
            and(
              eq(schema.webSources.parkingLotId, data.parkingLotId),
              sql`${schema.webSources.relevanceScore} >= 40`,
              notAggregator(),
            ),
          )
          .orderBy(desc(schema.webSources.sentimentScore))
          // lot 당 최대 120행까지 있다(평균 2.1행). 목록은 접혀 있고 읽을거리도 아니라
          // 전부 실어 보낼 이유가 없다. loader 페이로드가 그만큼 커진다.
          .limit(30),
        db
          .select({ cnt: count() })
          .from(schema.webSources)
          .where(
            and(
              eq(schema.webSources.parkingLotId, data.parkingLotId),
              // 노출 대상이었을 행만 센다. 이 조건이 없으면 애초에 화면에 안 나왔을 행까지 세어
              // "N건은 뺐습니다" 의 N 이 실제로 뺀 수보다 커진다.
              sql`${schema.webSources.relevanceScore} >= 40`,
              sql`${schema.webSources.filterV2Reason} = 'aggregator_site'`,
            ),
          )
          .get(),
      ])

      return {
        sources: kept.map((r) => ({
          id: r.id,
          title: r.title,
          sourceUrl: r.sourceUrl,
          host: extractHost(r.sourceUrl) ?? '',
          publishedAt: r.publishedAt ?? undefined,
          author: r.author ?? undefined,
        })),
        excludedCount: excluded?.cnt ?? 0,
      }
    },
  )

/**
 * 후기에서 함께 언급된 주차장 (3-1)
 *
 * `lot_alternatives` 는 배치(scripts/extract-alternative-lots.ts)가 채운다.
 * 저장 단계에서 이미 (a) 우리 DB 와 이름이 정확히 매칭됐고 (b) 3km 이내인 것만 남겼다 —
 * 이름만 같은 전국의 동명 주차장으로 사람을 보내지 않으려는 것이다.
 */
export const fetchAlternativeLots = createServerFn({ method: 'GET' })
  .inputValidator((input: { parkingLotId: string }): { parkingLotId: string } => input)
  .handler(
    async ({
      data,
    }): Promise<
      Array<{
        name: string
        mentionCount: number
        matchedLotId: string | null
        matchedLotName: string | null
        isFree: boolean | null
        reason: string
      }>
    > => {
      const db = getDb()
      const rows = await db.all(
        sql`SELECT a.display_name, a.mention_count, a.matched_lot_id,
                   p.name AS matched_name, p.is_free
              FROM lot_alternatives a
              JOIN parking_lots p ON p.id = a.matched_lot_id
             WHERE a.parking_lot_id = ${data.parkingLotId}
             ORDER BY a.mention_count DESC
             LIMIT 5`,
      )

      return (rows as unknown as Array<Record<string, unknown>>).map((r) => {
        const count = Number(r.mention_count ?? 0)
        return {
          name: String(r.matched_name ?? r.display_name ?? ''),
          mentionCount: count,
          matchedLotId: String(r.matched_lot_id ?? ''),
          matchedLotName: String(r.matched_name ?? ''),
          // 무료 여부는 매칭된 주차장의 실제 값을 쓴다.
          // 추출 단계의 '주변에 무료 언급' 힌트는 근거가 못 된다 —
          // "여기는 무료인데 저기는 유료다" 같은 문장에서 반대로 붙는다.
          isFree: r.is_free === 1 || r.is_free === true,
          reason: `후기 ${count}건에서 함께 언급`,
        }
      })
    },
  )

export const fetchBlogPosts = createServerFn({ method: 'GET' })
  .inputValidator(
    (input: {
      parkingLotId: string
      offset?: number
      limit?: number
    }): { parkingLotId: string; offset?: number; limit?: number } => input,
  )
  .handler(async ({ data }): Promise<BlogPost[]> => {
    const db = getDb()
    const limit = data.limit ?? 10
    const offset = data.offset ?? 0

    const rows = await db
      .select({
        id: schema.webSources.id,
        title: schema.webSources.title,
        content: schema.webSources.content,
        // 레거시 summary(거의 비어있음) 대신 원본 AI 합성 요약을 노출.
        // BlogPostCard가 summary ?? snippet 순으로 렌더 → raw 스크랩 대신 ai_summary 표시.
        summary: schema.webSources.aiSummary,
        source_url: schema.webSources.sourceUrl,
        source: schema.webSources.source,
        author: schema.webSources.author,
        published_at: schema.webSources.publishedAt,
        relevance_score: schema.webSources.relevanceScore,
        // INSTR 사용: LIKE의 우변이 컬럼 참조로 동적 구성될 때 D1/SQLite가
        // "LIKE or GLOB pattern too complex" (SQLITE_ERROR 7500)를 던지는 경우가 있어 회피.
        boost_score: sql<number>`
          CASE
            WHEN INSTR(${schema.webSources.title}, ${schema.parkingLots.name}) > 0 THEN 30
            ELSE 0
          END`.as('boost_score'),
      })
      .from(schema.webSources)
      .innerJoin(schema.parkingLots, eq(schema.webSources.parkingLotId, schema.parkingLots.id))
      .where(
        and(
          eq(schema.webSources.parkingLotId, data.parkingLotId),
          sql`${schema.webSources.relevanceScore} >= 40`,
          notAggregator(),
        ),
      )
      .orderBy(
        desc(sql`${schema.webSources.relevanceScore} + CASE
            WHEN INSTR(${schema.webSources.title}, ${schema.parkingLots.name}) > 0 THEN 30
            ELSE 0
          END`),
        desc(schema.webSources.publishedAt),
      )
      .limit(limit)
      .offset(offset)

    return rows.map((row) => rowToBlogPost(row as BlogPostRow))
  })

/** 주차장 미디어 (YouTube 등) */
export const fetchParkingMedia = createServerFn({ method: 'GET' })
  .inputValidator(
    (input: { parkingLotId: string; limit?: number }): { parkingLotId: string; limit?: number } =>
      input,
  )
  .handler(async ({ data }) => {
    const db = getDb()
    const limit = data.limit ?? 20

    const rows = await db
      .select({
        id: schema.parkingMedia.id,
        media_type: schema.parkingMedia.mediaType,
        url: schema.parkingMedia.url,
        title: schema.parkingMedia.title,
        thumbnail_url: schema.parkingMedia.thumbnailUrl,
        description: schema.parkingMedia.description,
      })
      .from(schema.parkingMedia)
      .where(eq(schema.parkingMedia.parkingLotId, data.parkingLotId))
      .orderBy(desc(schema.parkingMedia.createdAt))
      .limit(limit)

    return rows.map((row) => rowToMedia(row as MediaRow))
  })

/** 리뷰 요약 오류 신고 */
export const reportReview = createServerFn({ method: 'POST' })
  .inputValidator(
    (input: {
      sourceUrl: string
      parkingLotId: string
      reason: string
    }): {
      sourceUrl: string
      parkingLotId: string
      reason: string
    } => input,
  )
  .handler(async ({ data }) => {
    const db = getDb()
    await db.insert(schema.reviewReports).values({
      sourceUrl: data.sourceUrl,
      parkingLotId: data.parkingLotId,
      reason: data.reason,
    })
    return { ok: true }
  })

/** 주차장 주변 장소 (AI 추출) */
export const fetchNearbyPlaces = createServerFn({ method: 'GET' })
  .inputValidator((input: { parkingLotId: string }): { parkingLotId: string } => input)
  .handler(async ({ data }): Promise<NearbyPlaceInfo[]> => {
    const db = getDb()
    const rows = await db
      .select({
        id: schema.nearbyPlaces.id,
        name: schema.nearbyPlaces.name,
        category: schema.nearbyPlaces.category,
        tip: schema.nearbyPlaces.tip,
        mentionCount: schema.nearbyPlaces.mentionCount,
        thumbnailUrl: schema.nearbyPlaces.thumbnailUrl,
      })
      .from(schema.nearbyPlaces)
      .where(eq(schema.nearbyPlaces.parkingLotId, data.parkingLotId))
      .orderBy(desc(schema.nearbyPlaces.mentionCount))
      .limit(10)

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      category: row.category as NearbyPlaceInfo['category'],
      tip: row.tip ?? undefined,
      mentionCount: row.mentionCount,
      thumbnailUrl: row.thumbnailUrl ?? undefined,
    }))
  })

/** 지역 가이드 목록: 16개 반값여행 지역 통계 */
export const fetchGuideList = createServerFn({ method: 'GET' }).handler(async () => {
  const { REGIONS } = await import('@/lib/regions')
  const db = getDb()

  const results = await Promise.all(
    REGIONS.map(async (region) => {
      const row = (await db.get(
        sql.raw(
          `SELECT COUNT(*) as total,
            SUM(CASE WHEN is_free = 1 THEN 1 ELSE 0 END) as free_count,
            ROUND(AVG(CASE WHEN total_spaces > 0 THEN total_spaces END), 0) as avg_spaces
          FROM parking_lots
          WHERE address LIKE '${region.prefix}%' OR address LIKE '%${region.prefix}%'`,
        ),
      )) as { total: number; free_count: number; avg_spaces: number | null }

      return {
        slug: region.slug,
        name: region.name,
        province: region.province,
        total: row?.total ?? 0,
        freeCount: row?.free_count ?? 0,
        avgSpaces: row?.avg_spaces ?? 0,
      }
    }),
  )

  return results.filter((r) => r.total > 0)
})

/** 지역 가이드 상세: 초보추천/무료/넓은 주차장 + 관광 스팟 */
export const fetchGuideDetail = createServerFn({ method: 'GET' })
  .inputValidator((input: { slug: string }): { slug: string } => input)
  .handler(async ({ data }) => {
    const { findRegion } = await import('@/lib/regions')
    const region = findRegion(data.slug)
    if (!region) return null

    const db = getDb()
    const prefix = region.prefix
    const likeClause = `(p.address LIKE '${prefix}%' OR p.address LIKE '%${prefix}%')`

    const [summaryRow, easyRows, freeRows, largeRows] = await Promise.all([
      db.get(
        sql.raw(
          `SELECT COUNT(*) as total,
            SUM(CASE WHEN is_free = 1 THEN 1 ELSE 0 END) as free_count,
            ROUND(AVG(CASE WHEN total_spaces > 0 THEN total_spaces END), 0) as avg_spaces
          FROM parking_lots p WHERE ${likeClause}`,
        ),
      ) as Promise<{ total: number; free_count: number; avg_spaces: number | null }>,
      db.all(
        sql.raw(
          `SELECT p.*, s.final_score as avg_score,
            COALESCE(s.review_count, 0) as review_count,
            s.reliability
          FROM parking_lots p
          LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
          WHERE ${likeClause} AND (p.curation_tag = 'easy' OR s.final_score >= 3.5)
          ORDER BY s.final_score DESC LIMIT 10`,
        ),
      ),
      db.all(
        sql.raw(
          `SELECT p.*, s.final_score as avg_score,
            COALESCE(s.review_count, 0) as review_count,
            s.reliability
          FROM parking_lots p
          LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
          WHERE ${likeClause} AND p.is_free = 1
          ORDER BY p.total_spaces DESC LIMIT 10`,
        ),
      ),
      db.all(
        sql.raw(
          `SELECT p.*, s.final_score as avg_score,
            COALESCE(s.review_count, 0) as review_count,
            s.reliability
          FROM parking_lots p
          LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
          WHERE ${likeClause} AND p.total_spaces >= 200
          ORDER BY p.total_spaces DESC LIMIT 10`,
        ),
      ),
    ])

    return {
      region: { name: region.name, province: region.province, slug: region.slug },
      summary: {
        total: summaryRow?.total ?? 0,
        freeCount: summaryRow?.free_count ?? 0,
        avgSpaces: summaryRow?.avg_spaces ?? 0,
      },
      easy: (easyRows as unknown as ParkingLotRow[]).map(rowToParkingLot),
      free: (freeRows as unknown as ParkingLotRow[]).map(rowToParkingLot),
      large: (largeRows as unknown as ParkingLotRow[]).map(rowToParkingLot),
    }
  })

/** 카카오 키워드 장소 검색 (목적지 → 주변 주차장 찾기용) */
export const searchPlaces = createServerFn({ method: 'GET' })
  .inputValidator((input: { query: string }): { query: string } => input)
  .handler(async ({ data }): Promise<Place[]> => {
    const apiKey = env.KAKAO_CLIENT_ID
    if (!apiKey) return []

    // "석촌역 근처 주차장" → 핵심 검색어 "석촌역"으로도 질의한다.
    // 카카오는 실시간 호출만 허용되므로 응답은 저장하지 않고 그대로 흘려보낸다.
    const originalQuery = data.query.trim()
    const coreQuery = coreQueryString(originalQuery)
    const queries = [coreQuery, originalQuery].filter(
      (q, i, arr) => q.length >= 2 && arr.indexOf(q) === i,
    )
    if (queries.length === 0) return []

    const fetchPlaces = async (query: string): Promise<Place[]> => {
      const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(query)}&size=5`
      const res = await fetch(url, { headers: { Authorization: `KakaoAK ${apiKey}` } })
      if (!res.ok) return []
      const json = (await res.json()) as { documents: KakaoPlaceDocument[] }
      return parseKakaoPlaces(json.documents)
    }

    const groups = await Promise.all(queries.map(fetchPlaces))
    return mergePlaces(...groups).slice(0, 5)
  })
