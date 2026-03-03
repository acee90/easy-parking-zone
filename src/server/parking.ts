import { createServerFn } from "@tanstack/react-start";
import { getDB } from "@/lib/db";
import type { ParkingLot, MapBounds, MarkerCluster, CrawledReview } from "@/types/parking";

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
  avg_score: number | null;
  review_count: number;
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
  };
}

/** bounds 내 주차장 목록 조회 (리뷰 평균 점수 JOIN) */
export const fetchParkingLots = createServerFn({ method: "GET" })
  .inputValidator(
    (input: MapBounds & { limit?: number }): MapBounds & { limit?: number } =>
      input
  )
  .handler(async ({ data }) => {
    const db = getDB();
    const limit = data.limit ?? 200;

    const result = await db
      .prepare(
        `SELECT p.*,
          AVG(r.overall_score) as avg_score,
          COUNT(r.id) as review_count
        FROM parking_lots p
        LEFT JOIN reviews r ON r.parking_lot_id = p.id
        WHERE p.lat BETWEEN ?1 AND ?2
          AND p.lng BETWEEN ?3 AND ?4
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
    (input: MapBounds & { zoom: number }): MapBounds & { zoom: number } => input
  )
  .handler(async ({ data }): Promise<MarkerCluster[]> => {
    const db = getDB();
    const cellSize = 360 / Math.pow(2, data.zoom);

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
          AND p.lng BETWEEN ?4 AND ?5
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

/** 주차장별 크롤링 후기 조회 — 난이도 관련 문장만 추출 + 긍정/부정 판단 */
interface CrawledReviewRow {
  title: string;
  content: string;
  source_url: string;
}

const PARKING_KW = ["주차", "진입", "출차", "통로", "자리", "면", "입구", "출구", "경사", "회전", "좁", "넓", "기계식", "지하", "지상"];
const POS_KW = ["넓", "쉽", "편하", "편리", "여유", "충분", "널널", "넓직", "수월", "무난", "좋"];
const NEG_KW = ["좁", "어렵", "복잡", "힘들", "까다", "비좁", "불편", "혼잡", "만차", "협소", "위험", "조심"];

function summarizeReview(title: string, content: string): { summary: string; isPositive: boolean } {
  const text = `${title} ${content}`;
  const sentences = text
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);

  const relevant = sentences.filter((s) =>
    PARKING_KW.some((k) => s.includes(k))
  );

  const pool = relevant.length > 0 ? relevant : sentences;
  let pos = 0;
  let neg = 0;
  for (const s of pool) {
    if (POS_KW.some((k) => s.includes(k))) pos++;
    if (NEG_KW.some((k) => s.includes(k))) neg++;
  }

  const summary = (relevant.length > 0 ? relevant : sentences)
    .slice(0, 3)
    .join(". ")
    .slice(0, 300);

  return { summary, isPositive: pos >= neg };
}

export const fetchCrawledReviews = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { parkingLotId: string }): { parkingLotId: string } => input
  )
  .handler(async ({ data }): Promise<CrawledReview[]> => {
    const db = getDB();

    const result = await db
      .prepare(
        `SELECT title, content, source_url
         FROM crawled_reviews
         WHERE parking_lot_id = ?1
           AND relevance_score >= 40
         ORDER BY relevance_score DESC
         LIMIT 5`
      )
      .bind(data.parkingLotId)
      .all<CrawledReviewRow>();

    return (result.results ?? [])
      .map((row: CrawledReviewRow) => {
        const { summary, isPositive } = summarizeReview(row.title, row.content);
        return { summary, isPositive, sourceUrl: row.source_url };
      })
      .filter((r) => r.summary.length > 0);
  });
