import { env } from 'cloudflare:workers'
import { createServerFn } from '@tanstack/react-start'
import { count, desc, eq, sql } from 'drizzle-orm'
import { getDb, schema } from '@/db'
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

/** 사이트 전체 통계 (6시간 Cache API 캐싱) */
export const fetchSiteStats = createServerFn({ method: 'GET' }).handler(async () => {
  const CACHE_KEY = 'https://easy-parking.xyz/__internal/site-stats'
  const CACHE_TTL = 6 * 60 * 60 // 6시간

  const cache = typeof caches !== 'undefined' ? await caches.open('site-stats') : null
  if (cache) {
    const cached = await cache.match(CACHE_KEY)
    if (cached) return cached.json()
  }

  const db = getDb()
  const [lots, reviews, media] = await Promise.all([
    db.select({ cnt: count() }).from(schema.parkingLots).get(),
    db.select({ cnt: count() }).from(schema.userReviews).get(),
    db
      .select({
        cnt: sql<number>`(SELECT COUNT(*) FROM parking_media) + (SELECT COUNT(*) FROM web_sources)`,
      })
      .from(schema.parkingMedia)
      .get(),
  ])
  const stats = {
    parkingLots: lots?.cnt ?? 0,
    reviews: reviews?.cnt ?? 0,
    mediaPosts: media?.cnt ?? 0,
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
          COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
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
  async (): Promise<ParkingPoint[]> => {
    const db = getDb()

    const CACHE_KEY = 'https://cache.internal/parking-points-v1'
    const CACHE_TTL = 3600 // 1시간

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
    const words = data.query
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 1)
    if (words.length === 0) return []

    const conditions = words.map((w) => {
      const like = `%${w}%`
      return sql`(p.name LIKE ${like} OR p.address LIKE ${like} OR p.poi_tags LIKE ${like})`
    })

    const rows = await db.all(
      sql`SELECT p.*,
          s.final_score as avg_score,
          COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
          s.reliability
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE ${sql.join(conditions, sql` AND `)}
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
  .handler(async ({ data }) => {
    const db = getDb()
    const rows = await db.all(
      sql`SELECT p.*,
          s.final_score as avg_score,
          COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
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
    return rowToParkingLot(rows[0] as unknown as ParkingLotRow)
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
          COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
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

/** 주차장 탭 카운트 (리뷰/블로그/영상) 한번에 조회 */
export const fetchTabCounts = createServerFn({ method: 'GET' })
  .inputValidator((input: { parkingLotId: string }): { parkingLotId: string } => input)
  .handler(async ({ data }): Promise<{ reviews: number; blog: number; media: number }> => {
    const db = getDb()
    const [reviews, blog, media] = await Promise.all([
      db
        .select({ cnt: count() })
        .from(schema.userReviews)
        .where(eq(schema.userReviews.parkingLotId, data.parkingLotId))
        .get(),
      db
        .select({ cnt: count() })
        .from(schema.webSources)
        .where(eq(schema.webSources.parkingLotId, data.parkingLotId))
        .get(),
      db
        .select({ cnt: count() })
        .from(schema.parkingMedia)
        .where(eq(schema.parkingMedia.parkingLotId, data.parkingLotId))
        .get(),
    ])
    return {
      reviews: reviews?.cnt ?? 0,
      blog: blog?.cnt ?? 0,
      media: media?.cnt ?? 0,
    }
  })

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
        source_url: schema.webSources.sourceUrl,
        source: schema.webSources.source,
        author: schema.webSources.author,
        published_at: schema.webSources.publishedAt,
        relevance_score: schema.webSources.relevanceScore,
        boost_score: sql<number>`
          CASE 
            WHEN ${schema.webSources.title} LIKE '%' || ${schema.parkingLots.name} || '%' THEN 30
            ELSE 0 
          END`.as('boost_score'),
      })
      .from(schema.webSources)
      .innerJoin(schema.parkingLots, eq(schema.webSources.parkingLotId, schema.parkingLots.id))
      .where(
        and(
          eq(schema.webSources.parkingLotId, data.parkingLotId),
          sql`${schema.webSources.relevanceScore} >= 40`
        )
      )
      .orderBy(
        desc(sql`${schema.webSources.relevanceScore} + CASE 
            WHEN ${schema.webSources.title} LIKE '%' || ${schema.parkingLots.name} || '%' THEN 30
            ELSE 0 
          END`),
        desc(schema.webSources.publishedAt)
      )
      .limit(limit)
      .offset(offset)

    return rows.map((row) => rowToBlogPost(row as BlogPostRow))
  })

/** 주차장 미디어 (YouTube 등) */
export const fetchParkingMedia = createServerFn({ method: 'GET' })
  .inputValidator((input: { parkingLotId: string }): { parkingLotId: string } => input)
  .handler(async ({ data }) => {
    const db = getDb()

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
      .limit(5)

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
            COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
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
            COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
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
            COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
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
    if (!apiKey || data.query.trim().length < 2) return []

    const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(data.query)}&size=5`
    const res = await fetch(url, {
      headers: { Authorization: `KakaoAK ${apiKey}` },
    })
    if (!res.ok) return []

    const json = (await res.json()) as {
      documents: Array<{
        place_name: string
        address_name: string
        x: string
        y: string
        category_group_name: string
      }>
    }

    return json.documents
      .filter((d) => d.category_group_name !== '주차장')
      .slice(0, 5)
      .map((d) => ({
        name: d.place_name,
        address: d.address_name,
        lat: parseFloat(d.y),
        lng: parseFloat(d.x),
        category: d.category_group_name || undefined,
      }))
  })
