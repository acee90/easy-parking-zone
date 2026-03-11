import { createServerFn } from "@tanstack/react-start";
import { getDb } from "@/db";
import { schema } from "@/db";
import { eq, and, sql, gte, count, desc } from "drizzle-orm";
import { env } from "cloudflare:workers";
import type { MapBounds, MarkerCluster, BlogPost, ParkingFilters, Place } from "@/types/parking";
import {
  rowToParkingLot, rowToBlogPost, rowToMedia,
  buildFilterClauses,
  type ParkingLotRow, type BlogPostRow, type MediaRow,
} from "./transforms";

/** 사이트 전체 통계 (6시간 Cache API 캐싱) */
export const fetchSiteStats = createServerFn({ method: "GET" }).handler(
  async () => {
    const CACHE_KEY = "https://easy-parking.xyz/__internal/site-stats";
    const CACHE_TTL = 6 * 60 * 60; // 6시간

    const cache = typeof caches !== "undefined" ? await caches.open("site-stats") : null;
    if (cache) {
      const cached = await cache.match(CACHE_KEY);
      if (cached) return cached.json();
    }

    const db = getDb();
    const [lots, reviews, media] = await Promise.all([
      db.select({ cnt: count() }).from(schema.parkingLots).get(),
      db.select({ cnt: count() }).from(schema.userReviews).get(),
      db.select({
        cnt: sql<number>`(SELECT COUNT(*) FROM parking_media) + (SELECT COUNT(*) FROM web_sources)`,
      }).from(schema.parkingMedia).get(),
    ]);
    const stats = {
      parkingLots: lots?.cnt ?? 0,
      reviews: reviews?.cnt ?? 0,
      mediaPosts: media?.cnt ?? 0,
    };

    if (cache) {
      await cache.put(
        CACHE_KEY,
        new Response(JSON.stringify(stats), {
          headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_TTL}` },
        })
      );
    }

    return stats;
  }
);

/** bounds 내 주차장 목록 조회 — 동적 WHERE + JOIN이 복잡하여 raw SQL 유지 */
export const fetchParkingLots = createServerFn({ method: "GET" })
  .inputValidator(
    (input: MapBounds & { limit?: number; filters?: ParkingFilters }): MapBounds & { limit?: number; filters?: ParkingFilters } =>
      input
  )
  .handler(async ({ data }) => {
    const db = getDb();
    const limit = data.limit ?? 200;
    const { where } = buildFilterClauses(data.filters);

    const rows = await db.all(
      sql.raw(
        `SELECT p.*,
          s.final_score as avg_score,
          COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
          s.reliability
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE p.lat BETWEEN ${data.south} AND ${data.north}
          AND p.lng BETWEEN ${data.west} AND ${data.east}${where}
        LIMIT ${limit}`
      )
    );

    return (rows as unknown as ParkingLotRow[]).map(rowToParkingLot);
  });

/** bounds 내 주차장을 그리드 셀로 클러스터링 (zoom ≤ 12) — raw SQL */
export const fetchParkingClusters = createServerFn({ method: "GET" })
  .inputValidator(
    (input: MapBounds & { zoom: number; filters?: ParkingFilters }): MapBounds & { zoom: number; filters?: ParkingFilters } => input
  )
  .handler(async ({ data }): Promise<MarkerCluster[]> => {
    const db = getDb();
    const cellSize = 360 / Math.pow(2, data.zoom);
    const { where } = buildFilterClauses(data.filters);

    const rows = await db.all(
      sql.raw(
        `SELECT
          CAST(p.lat / ${cellSize} AS INTEGER) || '_' || CAST(p.lng / ${cellSize} AS INTEGER) as cell_key,
          AVG(p.lat) as lat,
          AVG(p.lng) as lng,
          COUNT(*) as count,
          AVG(s.final_score) as avg_score
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE p.lat BETWEEN ${data.south} AND ${data.north}
          AND p.lng BETWEEN ${data.west} AND ${data.east}${where}
        GROUP BY CAST(p.lat / ${cellSize} AS INTEGER), CAST(p.lng / ${cellSize} AS INTEGER)`
      )
    );

    return (rows as unknown as { cell_key: string; lat: number; lng: number; count: number; avg_score: number | null }[]).map((row) => ({
      key: row.cell_key,
      lat: row.lat,
      lng: row.lng,
      count: row.count,
      avgScore: row.avg_score,
    }));
  });

/** 이름/주소 LIKE 검색 — raw SQL (동적 WHERE + JOIN) */
export const searchParkingLots = createServerFn({ method: "GET" })
  .inputValidator((input: { query: string }): { query: string } => input)
  .handler(async ({ data }) => {
    const db = getDb();
    const q = `%${data.query}%`;

    const rows = await db.all(
      sql`SELECT p.*,
          s.final_score as avg_score,
          COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
          s.reliability
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE p.name LIKE ${q} OR p.address LIKE ${q} OR p.poi_tags LIKE ${q}
        LIMIT 20`
    );

    return (rows as unknown as ParkingLotRow[]).map(rowToParkingLot);
  });

/** 주차장 탭 카운트 (리뷰/블로그/영상) 한번에 조회 */
export const fetchTabCounts = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { parkingLotId: string }): { parkingLotId: string } => input
  )
  .handler(async ({ data }): Promise<{ reviews: number; blog: number; media: number }> => {
    const db = getDb();
    const [reviews, blog, media] = await Promise.all([
      db.select({ cnt: count() })
        .from(schema.userReviews)
        .where(eq(schema.userReviews.parkingLotId, data.parkingLotId))
        .get(),
      db.select({ cnt: count() })
        .from(schema.webSources)
        .where(
          and(
            eq(schema.webSources.parkingLotId, data.parkingLotId),
            gte(schema.webSources.relevanceScore, 40),
            sql`${schema.webSources.sourceUrl} NOT LIKE '%youtube.com%'`,
            sql`${schema.webSources.sourceUrl} NOT LIKE '%youtu.be%'`,
          )
        )
        .get(),
      db.select({ cnt: count() })
        .from(schema.parkingMedia)
        .where(eq(schema.parkingMedia.parkingLotId, data.parkingLotId))
        .get(),
    ]);
    return {
      reviews: reviews?.cnt ?? 0,
      blog: blog?.cnt ?? 0,
      media: media?.cnt ?? 0,
    };
  });

export const fetchBlogPosts = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { parkingLotId: string }): { parkingLotId: string } => input
  )
  .handler(async ({ data }): Promise<BlogPost[]> => {
    const db = getDb();

    const rows = await db
      .select({
        title: schema.webSources.title,
        content: schema.webSources.content,
        source_url: schema.webSources.sourceUrl,
        source: schema.webSources.source,
        author: schema.webSources.author,
        published_at: schema.webSources.publishedAt,
      })
      .from(schema.webSources)
      .where(
        and(
          eq(schema.webSources.parkingLotId, data.parkingLotId),
          gte(schema.webSources.relevanceScore, 40),
          sql`${schema.webSources.sourceUrl} NOT LIKE '%youtube.com%'`,
          sql`${schema.webSources.sourceUrl} NOT LIKE '%youtu.be%'`,
        )
      )
      .orderBy(desc(schema.webSources.relevanceScore))
      .limit(5);

    return rows.map((row) => rowToBlogPost(row as BlogPostRow));
  });

/** 주차장 미디어 (YouTube 등) */
export const fetchParkingMedia = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { parkingLotId: string }): { parkingLotId: string } => input
  )
  .handler(async ({ data }) => {
    const db = getDb();

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
      .limit(5);

    return rows.map((row) => rowToMedia(row as MediaRow));
  });

/** 리뷰 요약 오류 신고 */
export const reportReview = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { sourceUrl: string; parkingLotId: string; reason: string }): {
      sourceUrl: string;
      parkingLotId: string;
      reason: string;
    } => input
  )
  .handler(async ({ data }) => {
    const db = getDb();
    await db.insert(schema.reviewReports).values({
      sourceUrl: data.sourceUrl,
      parkingLotId: data.parkingLotId,
      reason: data.reason,
    });
    return { ok: true };
  });

/** 카카오 키워드 장소 검색 (목적지 → 주변 주차장 찾기용) */
export const searchPlaces = createServerFn({ method: "GET" })
  .inputValidator((input: { query: string }): { query: string } => input)
  .handler(async ({ data }): Promise<Place[]> => {
    const apiKey = env.KAKAO_CLIENT_ID;
    if (!apiKey || data.query.trim().length < 2) return [];

    const url = `https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(data.query)}&size=5`;
    const res = await fetch(url, {
      headers: { Authorization: `KakaoAK ${apiKey}` },
    });
    if (!res.ok) return [];

    const json = (await res.json()) as {
      documents: Array<{
        place_name: string;
        address_name: string;
        x: string;
        y: string;
        category_group_name: string;
      }>;
    };

    return json.documents
      .filter((d) => d.category_group_name !== "주차장")
      .slice(0, 5)
      .map((d) => ({
        name: d.place_name,
        address: d.address_name,
        lat: parseFloat(d.y),
        lng: parseFloat(d.x),
        category: d.category_group_name || undefined,
      }));
  });
