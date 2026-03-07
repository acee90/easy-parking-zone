import { createServerFn } from "@tanstack/react-start";
import { getDB } from "@/lib/db";
import type { ParkingLot, MapBounds, MarkerCluster, BlogPost, ParkingFilters, ParkingMedia } from "@/types/parking";

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
  avg_score: number | null;
  review_count: number;
}

function buildFilterClauses(filters?: ParkingFilters): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters?.freeOnly) clauses.push("p.is_free = 1");
  if (filters?.publicOnly) clauses.push("p.id NOT LIKE 'KA-%' AND p.id NOT LIKE 'NV-%'");
  if (filters?.excludeNoSang) clauses.push("p.type != '노상'");
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
    },
    phone: row.phone ?? undefined,
    paymentMethods: row.payment_methods ?? undefined,
    notes: row.notes ?? undefined,
    curationTag: row.curation_tag as ParkingLot['curationTag'],
    curationReason: row.curation_reason ?? undefined,
  };
}

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
          AVG(r.overall_score) as avg_score,
          COUNT(r.id) as review_count
        FROM parking_lots p
        LEFT JOIN reviews r ON r.parking_lot_id = p.id
        WHERE p.lat BETWEEN ?1 AND ?2
          AND p.lng BETWEEN ?3 AND ?4${where}
        GROUP BY p.id
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
          AVG(ls.avg_score) as avg_score
        FROM parking_lots p
        LEFT JOIN (
          SELECT parking_lot_id, AVG(overall_score) as avg_score
          FROM reviews
          GROUP BY parking_lot_id
        ) ls ON ls.parking_lot_id = p.id
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
          AVG(r.overall_score) as avg_score,
          COUNT(r.id) as review_count
        FROM parking_lots p
        LEFT JOIN reviews r ON r.parking_lot_id = p.id
        WHERE p.name LIKE ?1 OR p.address LIKE ?1
        GROUP BY p.id
        LIMIT 20`
      )
      .bind(q)
      .all<ParkingLotRow>();

    return (result.results ?? []).map(rowToParkingLot);
  });

/** 주차장별 블로그 후기 (스니펫) */
interface BlogPostRow {
  title: string;
  content: string;
  source_url: string;
  source: string;
  author: string;
  published_at: string | null;
}

export const fetchBlogPosts = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { parkingLotId: string }): { parkingLotId: string } => input
  )
  .handler(async ({ data }): Promise<BlogPost[]> => {
    const db = getDB();

    const result = await db
      .prepare(
        `SELECT title, content, source_url, source, author, published_at
         FROM crawled_reviews
         WHERE parking_lot_id = ?1
           AND relevance_score >= 40
         ORDER BY relevance_score DESC
         LIMIT 5`
      )
      .bind(data.parkingLotId)
      .all<BlogPostRow>();

    return (result.results ?? []).map((row) => ({
      title: row.title,
      snippet: row.content,
      sourceUrl: row.source_url,
      source: row.source as "naver_blog" | "naver_cafe",
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
