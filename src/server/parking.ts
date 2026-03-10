import { createServerFn } from "@tanstack/react-start";
import { getDB } from "@/lib/db";
import { buildDifficultyCondition } from "@/lib/filter-utils";
import { env } from "cloudflare:workers";
import type { ParkingLot, MapBounds, MarkerCluster, BlogPost, ParkingFilters, ParkingMedia, Place } from "@/types/parking";

interface ParkingLotRow {
  id: string;
  name: string;
  type: string;
  address: string;
  lat: number;
  lng: number;
  total_spaces: number;
  free_spaces: number | null;
  weekday_start: string;
  weekday_end: string;
  saturday_start: string;
  saturday_end: string;
  holiday_start: string;
  holiday_end: string;
  is_free: number;
  base_time: number | null;
  base_fee: number | null;
  extra_time: number | null;
  extra_fee: number | null;
  daily_max: number | null;
  monthly_pass: number | null;
  phone: string | null;
  payment_methods: string | null;
  notes: string | null;
  curation_tag: string | null;
  curation_reason: string | null;
  featured_source: string | null;
  avg_score: number | null;
  review_count: number;
  reliability: string | null;
}

function buildFilterClauses(filters?: ParkingFilters): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters?.freeOnly) clauses.push("p.is_free = 1");
  if (filters?.publicOnly) clauses.push("p.id NOT LIKE 'KA-%' AND p.id NOT LIKE 'NV-%'");
  if (filters?.excludeNoSang) clauses.push("p.type != '노상'");

  // 난이도 필터는 parking_lot_stats.final_score 기반 WHERE 조건
  const diffCond = buildDifficultyCondition(filters, "s.final_score");
  if (diffCond) clauses.push(diffCond);

  return {
    where: clauses.length > 0 ? " AND " + clauses.join(" AND ") : "",
    params,
  };
}

function rowToParkingLot(row: ParkingLotRow): ParkingLot {
  const score = row.avg_score ?? null;
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    totalSpaces: row.total_spaces,
    freeSpaces: row.free_spaces ?? undefined,
    operatingHours: {
      weekday: { start: row.weekday_start, end: row.weekday_end },
      saturday: { start: row.saturday_start, end: row.saturday_end },
      holiday: { start: row.holiday_start, end: row.holiday_end },
    },
    pricing: {
      isFree: row.is_free === 1,
      baseTime: row.base_time ?? 0,
      baseFee: row.base_fee ?? 0,
      extraTime: row.extra_time ?? 0,
      extraFee: row.extra_fee ?? 0,
      dailyMax: row.daily_max ?? undefined,
      monthlyPass: row.monthly_pass ?? undefined,
    },
    difficulty: {
      score,
      reviewCount: row.review_count,
      reliability: (row.reliability as ParkingLot['difficulty']['reliability']) ?? undefined,
    },
    phone: row.phone ?? undefined,
    paymentMethods: row.payment_methods ?? undefined,
    notes: row.notes ?? undefined,
    curationTag: row.curation_tag as ParkingLot['curationTag'],
    curationReason: row.curation_reason ?? undefined,
    featuredSource: row.featured_source ?? undefined,
  };
}

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

    const db = getDB();
    const [lots, reviews, media] = await Promise.all([
      db.prepare("SELECT COUNT(*) as cnt FROM parking_lots").first<{ cnt: number }>(),
      db.prepare("SELECT COUNT(*) as cnt FROM user_reviews").first<{ cnt: number }>(),
      db.prepare(
        `SELECT
           (SELECT COUNT(*) FROM parking_media) +
           (SELECT COUNT(*) FROM web_sources) as cnt`
      ).first<{ cnt: number }>(),
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

/** bounds 내 주차장 목록 조회 (리뷰 평균 점수 JOIN) */
export const fetchParkingLots = createServerFn({ method: "GET" })
  .inputValidator(
    (input: MapBounds & { limit?: number; filters?: ParkingFilters }): MapBounds & { limit?: number; filters?: ParkingFilters } =>
      input
  )
  .handler(async ({ data }) => {
    const db = getDB();
    const limit = data.limit ?? 200;
    const { where } = buildFilterClauses(data.filters);

    const result = await db
      .prepare(
        `SELECT p.*,
          s.final_score as avg_score,
          COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
          s.reliability
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE p.lat BETWEEN ?1 AND ?2
          AND p.lng BETWEEN ?3 AND ?4${where}
        LIMIT ?5`
      )
      .bind(data.south, data.north, data.west, data.east, limit)
      .all<ParkingLotRow>();

    return (result.results ?? []).map(rowToParkingLot);
  });

/** bounds 내 주차장을 그리드 셀로 클러스터링 (zoom ≤ 12) */
export const fetchParkingClusters = createServerFn({ method: "GET" })
  .inputValidator(
    (input: MapBounds & { zoom: number; filters?: ParkingFilters }): MapBounds & { zoom: number; filters?: ParkingFilters } => input
  )
  .handler(async ({ data }): Promise<MarkerCluster[]> => {
    const db = getDB();
    const cellSize = 360 / Math.pow(2, data.zoom);
    const { where } = buildFilterClauses(data.filters);

    const result = await db
      .prepare(
        `SELECT
          CAST(p.lat / ?1 AS INTEGER) || '_' || CAST(p.lng / ?1 AS INTEGER) as cell_key,
          AVG(p.lat) as lat,
          AVG(p.lng) as lng,
          COUNT(*) as count,
          AVG(s.final_score) as avg_score
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE p.lat BETWEEN ?2 AND ?3
          AND p.lng BETWEEN ?4 AND ?5${where}
        GROUP BY CAST(p.lat / ?1 AS INTEGER), CAST(p.lng / ?1 AS INTEGER)`
      )
      .bind(cellSize, data.south, data.north, data.west, data.east)
      .all<{ cell_key: string; lat: number; lng: number; count: number; avg_score: number | null }>();

    return (result.results ?? []).map((row) => ({
      key: row.cell_key,
      lat: row.lat,
      lng: row.lng,
      count: row.count,
      avgScore: row.avg_score,
    }));
  });

/** 이름/주소 LIKE 검색 */
export const searchParkingLots = createServerFn({ method: "GET" })
  .inputValidator((input: { query: string }): { query: string } => input)
  .handler(async ({ data }) => {
    const db = getDB();
    const q = `%${data.query}%`;

    const result = await db
      .prepare(
        `SELECT p.*,
          s.final_score as avg_score,
          COALESCE(s.user_review_count, 0) + COALESCE(s.community_count, 0) as review_count,
          s.reliability
        FROM parking_lots p
        LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
        WHERE p.name LIKE ?1 OR p.address LIKE ?1
        LIMIT 20`
      )
      .bind(q)
      .all<ParkingLotRow>();

    return (result.results ?? []).map(rowToParkingLot);
  });

/** 주차장별 웹사이트 후기 (스니펫) */
interface BlogPostRow {
  title: string;
  content: string;
  source_url: string;
  source: string;
  author: string;
  published_at: string | null;
}

/** 주차장 탭 카운트 (리뷰/블로그/영상) 한번에 조회 */
export const fetchTabCounts = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { parkingLotId: string }): { parkingLotId: string } => input
  )
  .handler(async ({ data }): Promise<{ reviews: number; blog: number; media: number }> => {
    const db = getDB();
    const [reviews, blog, media] = await Promise.all([
      db.prepare(`SELECT COUNT(*) as cnt FROM user_reviews WHERE parking_lot_id = ?1`)
        .bind(data.parkingLotId).first<{ cnt: number }>(),
      db.prepare(
        `SELECT COUNT(*) as cnt FROM web_sources
         WHERE parking_lot_id = ?1 AND relevance_score >= 40
           AND source_url NOT LIKE '%youtube.com%' AND source_url NOT LIKE '%youtu.be%'`
      ).bind(data.parkingLotId).first<{ cnt: number }>(),
      db.prepare(`SELECT COUNT(*) as cnt FROM parking_media WHERE parking_lot_id = ?1`)
        .bind(data.parkingLotId).first<{ cnt: number }>(),
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
    const db = getDB();

    const result = await db
      .prepare(
        `SELECT title, content, source_url, source, author, published_at
         FROM web_sources
         WHERE parking_lot_id = ?1
           AND relevance_score >= 40
           AND source_url NOT LIKE '%youtube.com%'
           AND source_url NOT LIKE '%youtu.be%'
         ORDER BY relevance_score DESC
         LIMIT 5`
      )
      .bind(data.parkingLotId)
      .all<BlogPostRow>();

    return (result.results ?? []).map((row) => ({
      title: row.title,
      snippet: row.content,
      sourceUrl: row.source_url,
      source: row.source as BlogPost["source"],
      author: row.author,
      publishedAt: row.published_at ?? undefined,
    }));
  });

/** 주차장 미디어 (YouTube 등) */
interface MediaRow {
  id: number;
  media_type: string;
  url: string;
  title: string | null;
  thumbnail_url: string | null;
  description: string | null;
}

export const fetchParkingMedia = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { parkingLotId: string }): { parkingLotId: string } => input
  )
  .handler(async ({ data }): Promise<ParkingMedia[]> => {
    const db = getDB();

    const result = await db
      .prepare(
        `SELECT id, media_type, url, title, thumbnail_url, description
         FROM parking_media
         WHERE parking_lot_id = ?1
         ORDER BY created_at DESC
         LIMIT 5`
      )
      .bind(data.parkingLotId)
      .all<MediaRow>();

    return (result.results ?? []).map((row) => ({
      id: row.id,
      mediaType: row.media_type as ParkingMedia['mediaType'],
      url: row.url,
      title: row.title ?? undefined,
      thumbnailUrl: row.thumbnail_url ?? undefined,
      description: row.description ?? undefined,
    }));
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
    const db = getDB();
    await db
      .prepare(
        `INSERT INTO review_reports (source_url, parking_lot_id, reason)
         VALUES (?1, ?2, ?3)`
      )
      .bind(data.sourceUrl, data.parkingLotId, data.reason)
      .run();
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
