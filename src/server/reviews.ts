import { createServerFn } from '@tanstack/react-start'
import { and, count, eq, gt, sql } from 'drizzle-orm'
import { getDb, schema } from '@/db'
import { createAuth } from '@/lib/auth'
import type { UserReview } from '@/types/parking'
import { type ReviewRow, rowToReview, validateScore } from './transforms'

async function getSessionUserId(request: Request): Promise<string | null> {
  try {
    const auth = createAuth()
    const session = await auth.api.getSession({ headers: request.headers })
    return session?.user?.id ?? null
  } catch {
    return null
  }
}

async function hashIP(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip)
  const hash = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function getClientIP(request: Request): string {
  return (
    request.headers.get('cf-connecting-ip') ??
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

/** 주차장별 사용자 리뷰 목록 */
export const fetchUserReviews = createServerFn({ method: 'GET' })
  .inputValidator(
    (input: { parkingLotId: string; limit?: number }): { parkingLotId: string; limit?: number } =>
      input,
  )
  .handler(async ({ data, request }): Promise<UserReview[]> => {
    const db = getDb()
    const currentUserId = request ? await getSessionUserId(request) : null
    const limit = data.limit ?? 20

    // LEFT JOIN user 테이블은 Drizzle에서 raw SQL로 유지 (better-auth 테이블)
    const rows = await db
      .select({
        id: schema.userReviews.id,
        user_id: schema.userReviews.userId,
        guest_nickname: schema.userReviews.guestNickname,
        entry_score: schema.userReviews.entryScore,
        space_score: schema.userReviews.spaceScore,
        passage_score: schema.userReviews.passageScore,
        exit_score: schema.userReviews.exitScore,
        overall_score: schema.userReviews.overallScore,
        comment: schema.userReviews.comment,
        visited_at: schema.userReviews.visitedAt,
        created_at: schema.userReviews.createdAt,
        source_type: schema.userReviews.sourceType,
        source_url: schema.userReviews.sourceUrl,
        user_name: schema.users.name,
        user_image: schema.users.image,
      })
      .from(schema.userReviews)
      .leftJoin(schema.users, eq(schema.users.id, schema.userReviews.userId))
      .where(eq(schema.userReviews.parkingLotId, data.parkingLotId))
      .orderBy(sql`${schema.userReviews.createdAt} DESC`)
      .limit(limit)

    return rows.map((row) => rowToReview(row as ReviewRow, currentUserId))
  })

interface CreateReviewInput {
  parkingLotId: string
  entryScore: number
  spaceScore: number
  passageScore: number
  exitScore: number
  overallScore: number
  comment?: string
  visitedAt?: string
  guestNickname?: string
}

/** 리뷰 작성 (회원/비회원) */
export const createReview = createServerFn({ method: 'POST' })
  .inputValidator((input: CreateReviewInput): CreateReviewInput => {
    if (!input.parkingLotId) throw new Error('주차장 ID 필요')
    if (
      !validateScore(input.entryScore) ||
      !validateScore(input.spaceScore) ||
      !validateScore(input.passageScore) ||
      !validateScore(input.exitScore) ||
      !validateScore(input.overallScore)
    )
      throw new Error('점수는 1-5 정수')
    return input
  })
  .handler(async ({ data, request }) => {
    const db = getDb()
    const userId = request ? await getSessionUserId(request) : null

    // 비회원 rate limit: 같은 IP + 주차장에 24시간 내 1건
    let ipHash: string | null = null
    if (!userId && request) {
      ipHash = await hashIP(getClientIP(request))
      const [existing] = await db
        .select({ cnt: count() })
        .from(schema.userReviews)
        .where(
          and(
            eq(schema.userReviews.ipHash, ipHash),
            eq(schema.userReviews.parkingLotId, data.parkingLotId),
            gt(schema.userReviews.createdAt, sql`datetime('now', '-24 hours')`),
          ),
        )
      if (existing && existing.cnt > 0) {
        throw new Error('24시간 내에 같은 주차장에 이미 리뷰를 남겼습니다')
      }
    }

    // 회원 rate limit: 같은 주차장에 24시간 내 1건
    if (userId) {
      const [existing] = await db
        .select({ cnt: count() })
        .from(schema.userReviews)
        .where(
          and(
            eq(schema.userReviews.userId, userId),
            eq(schema.userReviews.parkingLotId, data.parkingLotId),
            gt(schema.userReviews.createdAt, sql`datetime('now', '-24 hours')`),
          ),
        )
      if (existing && existing.cnt > 0) {
        throw new Error('24시간 내에 같은 주차장에 이미 리뷰를 남겼습니다')
      }
    }

    await db.insert(schema.userReviews).values({
      parkingLotId: data.parkingLotId,
      userId,
      guestNickname: userId ? null : data.guestNickname || '익명',
      ipHash: userId ? null : ipHash,
      entryScore: data.entryScore,
      spaceScore: data.spaceScore,
      passageScore: data.passageScore,
      exitScore: data.exitScore,
      overallScore: data.overallScore,
      comment: data.comment ?? null,
      visitedAt: data.visitedAt ?? null,
    })

    return { ok: true }
  })

/** 리뷰 삭제 (본인만) */
export const deleteReview = createServerFn({ method: 'POST' })
  .inputValidator((input: { reviewId: number }): { reviewId: number } => input)
  .handler(async ({ data, request }) => {
    const userId = request ? await getSessionUserId(request) : null
    if (!userId) throw new Error('로그인 필요')

    const db = getDb()
    const review = await db
      .select({ userId: schema.userReviews.userId })
      .from(schema.userReviews)
      .where(eq(schema.userReviews.id, data.reviewId))
      .get()

    if (!review || review.userId !== userId) {
      throw new Error('본인 리뷰만 삭제 가능')
    }

    await db.delete(schema.userReviews).where(eq(schema.userReviews.id, data.reviewId))

    return { ok: true }
  })
