/**
 * DB row → 프론트엔드 타입 변환 함수
 * Drizzle 전환 후에도 동일 출력을 보장하기 위해 별도 모듈로 분리.
 * 서버 의존성 없이 순수 함수만 포함.
 */
import type { ParkingLot, BlogPost, ParkingMedia, ParkingFilters } from "@/types/parking";
import type { UserReview } from "@/types/parking";
import { buildDifficultyCondition } from "@/lib/filter-utils";

// ============================================================
// Parking Lot
// ============================================================

export interface ParkingLotRow {
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
  poi_tags: string | null;
  avg_score: number | null;
  review_count: number;
  reliability: string | null;
}

export function rowToParkingLot(row: ParkingLotRow): ParkingLot {
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
    poiTags: row.poi_tags ? JSON.parse(row.poi_tags) : undefined,
    curationTag: row.curation_tag as ParkingLot['curationTag'],
    curationReason: row.curation_reason ?? undefined,
    featuredSource: row.featured_source ?? undefined,
  };
}

export function buildFilterClauses(filters?: ParkingFilters): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filters?.freeOnly) clauses.push("p.is_free = 1");
  if (filters?.publicOnly) clauses.push("p.id NOT LIKE 'KA-%' AND p.id NOT LIKE 'NV-%'");
  if (filters?.excludeNoSang) clauses.push("p.type != '노상'");

  const diffCond = buildDifficultyCondition(filters, "s.final_score");
  if (diffCond) clauses.push(diffCond);

  return {
    where: clauses.length > 0 ? " AND " + clauses.join(" AND ") : "",
    params,
  };
}

// ============================================================
// Blog Post
// ============================================================

export interface BlogPostRow {
  title: string;
  content: string;
  source_url: string;
  source: string;
  author: string;
  published_at: string | null;
}

export function rowToBlogPost(row: BlogPostRow): BlogPost {
  return {
    title: row.title,
    snippet: row.content,
    sourceUrl: row.source_url,
    source: row.source as BlogPost["source"],
    author: row.author,
    publishedAt: row.published_at ?? undefined,
  };
}

// ============================================================
// Media
// ============================================================

export interface MediaRow {
  id: number;
  media_type: string;
  url: string;
  title: string | null;
  thumbnail_url: string | null;
  description: string | null;
}

export function rowToMedia(row: MediaRow): ParkingMedia {
  return {
    id: row.id,
    mediaType: row.media_type as ParkingMedia['mediaType'],
    url: row.url,
    title: row.title ?? undefined,
    thumbnailUrl: row.thumbnail_url ?? undefined,
    description: row.description ?? undefined,
  };
}

// ============================================================
// Review
// ============================================================

export interface ReviewRow {
  id: number;
  user_id: string | null;
  guest_nickname: string | null;
  entry_score: number;
  space_score: number;
  passage_score: number;
  exit_score: number;
  overall_score: number;
  comment: string | null;
  visited_at: string | null;
  created_at: string;
  user_name: string | null;
  user_image: string | null;
  source_type: string | null;
  source_url: string | null;
}

export function rowToReview(row: ReviewRow, currentUserId: string | null): UserReview {
  const isMember = row.user_id !== null;
  return {
    id: row.id,
    author: {
      type: isMember ? "member" : "guest",
      nickname: isMember
        ? (row.user_name ?? "사용자")
        : (row.guest_nickname ?? "익명"),
      profileImage: row.user_image ?? undefined,
    },
    scores: {
      entry: row.entry_score,
      space: row.space_score,
      passage: row.passage_score,
      exit: row.exit_score,
      overall: row.overall_score,
    },
    comment: row.comment ?? undefined,
    visitedAt: row.visited_at ?? undefined,
    createdAt: row.created_at,
    isMine: currentUserId !== null && row.user_id === currentUserId,
    sourceType: row.source_type ?? undefined,
    sourceUrl: row.source_url ?? undefined,
  };
}

// ============================================================
// Validation
// ============================================================

export function validateScore(v: unknown): v is number {
  return typeof v === "number" && v >= 1 && v <= 5 && Number.isInteger(v);
}
