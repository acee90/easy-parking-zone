/**
 * DB row → 프론트엔드 타입 변환 함수
 * Drizzle 전환 후에도 동일 출력을 보장하기 위해 별도 모듈로 분리.
 * 서버 의존성 없이 순수 함수만 포함.
 */

import { buildDifficultyCondition } from '@/lib/filter-utils'
import { stripSiteChrome } from '@/server/crawlers/lib/strip-site-chrome'
import type {
  BlogPost,
  ParkingFilters,
  ParkingLot,
  ParkingMedia,
  UserReview,
} from '@/types/parking'

// ============================================================
// Parking Lot
// ============================================================

export interface ParkingLotRow {
  id: string
  name: string
  type: string
  address: string
  lat: number
  lng: number
  total_spaces: number
  free_spaces: number | null
  weekday_start: string
  weekday_end: string
  saturday_start: string
  saturday_end: string
  holiday_start: string
  holiday_end: string
  is_free: number
  base_time: number | null
  base_fee: number | null
  extra_time: number | null
  extra_fee: number | null
  daily_max: number | null
  monthly_pass: number | null
  phone: string | null
  payment_methods: string | null
  notes: string | null
  curation_tag: string | null
  curation_reason: string | null
  featured_source: string | null
  poi_tags: string | null
  avg_score: number | null
  review_count: number
  reliability: string | null
  verified_source: string | null
  ai_summary?: string | null
  ai_summary_updated_at?: string | null
  ai_tip_pricing?: string | null
  ai_tip_visit?: string | null
  ai_tip_alternative?: string | null
}

/**
 * D1 숫자 컬럼을 안전하게 읽는다.
 *
 * 요금 컬럼 일부에 **문자열 `'null'`** 이 들어 있다 (2026-09-03 실측 676곳).
 * `?? 0` 은 이걸 못 거른다 — null 도 undefined 도 아니기 때문이다. 그대로 흘러가면
 * `base_fee + units * extra_fee` 가 문자열 연결이 되어 화면에 `nullNaN원` 이 찍힌다.
 * 숫자로 읽히지 않는 값은 **없는 것으로 본다.**
 */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

export function rowToParkingLot(row: ParkingLotRow): ParkingLot {
  const score = row.avg_score ?? null
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    address: row.address,
    lat: row.lat,
    lng: row.lng,
    totalSpaces: toNumber(row.total_spaces) ?? 0,
    freeSpaces: toNumber(row.free_spaces) ?? undefined,
    operatingHours: {
      weekday: { start: row.weekday_start, end: row.weekday_end },
      saturday: { start: row.saturday_start, end: row.saturday_end },
      holiday: { start: row.holiday_start, end: row.holiday_end },
    },
    pricing: {
      isFree: row.is_free === 1,
      baseTime: toNumber(row.base_time) ?? 0,
      baseFee: toNumber(row.base_fee) ?? 0,
      extraTime: toNumber(row.extra_time) ?? 0,
      extraFee: toNumber(row.extra_fee) ?? 0,
      dailyMax: toNumber(row.daily_max) ?? undefined,
      monthlyPass: toNumber(row.monthly_pass) ?? undefined,
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
    verifiedSource: row.verified_source ?? undefined,
    aiSummary: row.ai_summary ?? undefined,
    aiSummaryUpdatedAt: row.ai_summary_updated_at ?? undefined,
    aiTipPricing: row.ai_tip_pricing ?? undefined,
    aiTipVisit: row.ai_tip_visit ?? undefined,
    aiTipAlternative: row.ai_tip_alternative ?? undefined,
  }
}

export function buildFilterClauses(filters?: ParkingFilters): { where: string; params: unknown[] } {
  const clauses: string[] = []
  const params: unknown[] = []
  if (filters?.freeOnly) clauses.push('p.is_free = 1')
  if (filters?.publicOnly) clauses.push("p.id NOT LIKE 'KA-%' AND p.id NOT LIKE 'NV-%'")
  if (filters?.excludeNoSang) clauses.push("p.type != '노상'")

  const diffCond = buildDifficultyCondition(filters, 's.final_score')
  if (diffCond) clauses.push(diffCond)

  // 1시간 기준 요금 상한 필터 (무료 주차장은 항상 통과)
  if (filters?.feeRange && filters.feeRange !== 'any') {
    const maxFee = Number(filters.feeRange)
    clauses.push(
      `(p.is_free = 1 OR p.base_fee IS NULL OR p.base_fee = 0 OR ` +
        `(p.base_time IS NOT NULL AND p.base_time > 0 AND CAST(p.base_fee * 60.0 / p.base_time AS INTEGER) <= ?))`,
    )
    params.push(maxFee)
  }

  // 현재 운영중 필터 (요일별 운영시간 기준, KST 기준)
  if (filters?.openNow) {
    // Cloudflare Workers는 UTC로 실행되므로 KST(UTC+9) 오프셋 적용
    const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
    const day = kst.getUTCDay() // 0=일, 6=토
    const hh = String(kst.getUTCHours()).padStart(2, '0')
    const mm = String(kst.getUTCMinutes()).padStart(2, '0')
    const timeStr = `${hh}:${mm}`

    // end='00:00'은 24시간 운영, start > end는 자정 넘는 운영 (예: 20:00-06:00)
    const hoursOpen = (s: string, e: string) =>
      `(${s} IS NOT NULL AND ${s} != '' AND ` +
      `(${e} = '00:00' OR ` +
      `(${s} <= ${e} AND ${s} <= ? AND ${e} > ?) OR ` +
      `(${s} > ${e} AND (${s} <= ? OR ${e} > ?))))`

    if (day === 6) {
      clauses.push(hoursOpen('p.saturday_start', 'p.saturday_end'))
    } else if (day === 0) {
      clauses.push(hoursOpen('p.holiday_start', 'p.holiday_end'))
    } else {
      clauses.push(hoursOpen('p.weekday_start', 'p.weekday_end'))
    }
    params.push(timeStr, timeStr, timeStr, timeStr)
  }

  // 최소 주차면 수 필터
  if (filters?.minSpaces != null) {
    clauses.push(`p.total_spaces >= ?`)
    params.push(filters.minSpaces)
  }

  return {
    where: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '',
    params,
  }
}

// ============================================================
// Blog Post
// ============================================================

export interface BlogPostRow {
  id: number
  title: string
  content: string
  summary?: string | null
  source_url: string
  source: string
  author: string
  published_at: string | null
  relevance_score: number | null
}

export function rowToBlogPost(row: BlogPostRow): BlogPost {
  // 크롤 본문 앞뒤에 붙어 온 블로그 메뉴·버튼 글자를 걷어낸다.
  // 생성 시점에 이미 저장돼 버린 값이 많아 조회 시점에서도 한 번 더 거른다.
  // 걷어낸 뒤 남는 게 없으면(메뉴만 있던 글) 요약을 비워 원문 일부로 넘긴다.
  const cleanedSummary = stripSiteChrome(row.summary).text
  const cleanedSnippet = stripSiteChrome(row.content).text ?? row.content
  return {
    id: row.id,
    title: row.title,
    snippet: cleanedSnippet,
    summary: cleanedSummary ?? undefined,
    sourceUrl: row.source_url,
    source: row.source as BlogPost['source'],
    author: row.author,
    publishedAt: row.published_at ?? undefined,
    relevanceScore: row.relevance_score ?? undefined,
  }
}

// ============================================================
// Media
// ============================================================

export interface MediaRow {
  id: number
  media_type: string
  url: string
  title: string | null
  thumbnail_url: string | null
  description: string | null
}

export function rowToMedia(row: MediaRow): ParkingMedia {
  return {
    id: row.id,
    mediaType: row.media_type as ParkingMedia['mediaType'],
    url: row.url,
    title: row.title ?? undefined,
    thumbnailUrl: row.thumbnail_url ?? undefined,
    description: row.description ?? undefined,
  }
}

// ============================================================
// Review
// ============================================================

export interface ReviewRow {
  id: number
  user_id: string | null
  guest_nickname: string | null
  entry_score: number
  space_score: number
  passage_score: number
  exit_score: number
  overall_score: number
  comment: string | null
  visited_at: string | null
  created_at: string
  user_name: string | null
  user_image: string | null
  source_type: string | null
  source_url: string | null
}

export function rowToReview(row: ReviewRow, currentUserId: string | null): UserReview {
  const isMember = row.user_id !== null
  return {
    id: row.id,
    author: {
      type: isMember ? 'member' : 'guest',
      nickname: isMember ? (row.user_name ?? '사용자') : (row.guest_nickname ?? '익명'),
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
  }
}

// ============================================================
// Validation
// ============================================================

/** 점수 검증: 0.5 ~ 5.0 범위, 0.5점 단위 */
export function validateScore(v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false
  if (v < 0.5 || v > 5) return false
  // 0.5 단위 체크 (부동소수 오차 허용)
  return Math.abs(v * 2 - Math.round(v * 2)) < 1e-6
}
