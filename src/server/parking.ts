import { createServerFn } from "@tanstack/react-start";
import { getDB } from "@/lib/db";
import type { ParkingLot, MapBounds } from "@/types/parking";

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
