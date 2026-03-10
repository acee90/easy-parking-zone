import { createServerFn } from "@tanstack/react-start";
import { getDB } from "@/lib/db";
import { createAuth } from "@/lib/auth";
import type { UserReview } from "@/types/parking";

interface ReviewRow {
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

function rowToReview(row: ReviewRow, currentUserId: string | null): UserReview {
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

async function getSessionUserId(request: Request): Promise<string | null> {
  try {
    const auth = createAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

async function hashIP(ip: string): Promise<string> {
  const data = new TextEncoder().encode(ip);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getClientIP(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

/** 주차장별 사용자 리뷰 목록 */
export const fetchUserReviews = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { parkingLotId: string }): { parkingLotId: string } => input
  )
  .handler(async ({ data, request }): Promise<UserReview[]> => {
    const db = getDB();
    const currentUserId = request ? await getSessionUserId(request) : null;

    const result = await db
      .prepare(
        `SELECT r.id, r.user_id, r.guest_nickname,
                r.entry_score, r.space_score, r.passage_score,
                r.exit_score, r.overall_score,
                r.comment, r.visited_at, r.created_at,
                r.source_type, r.source_url,
                u.name as user_name, u.image as user_image
         FROM user_reviews r
         LEFT JOIN user u ON u.id = r.user_id
         WHERE r.parking_lot_id = ?1
         ORDER BY r.created_at DESC
         LIMIT 20`
      )
      .bind(data.parkingLotId)
      .all<ReviewRow>();

    return (result.results ?? []).map((row) =>
      rowToReview(row, currentUserId)
    );
  });

interface CreateReviewInput {
  parkingLotId: string;
  entryScore: number;
  spaceScore: number;
  passageScore: number;
  exitScore: number;
  overallScore: number;
  comment?: string;
  visitedAt?: string;
  guestNickname?: string;
}

function validateScore(v: unknown): v is number {
  return typeof v === "number" && v >= 1 && v <= 5 && Number.isInteger(v);
}

/** 리뷰 작성 (회원/비회원) */
export const createReview = createServerFn({ method: "POST" })
  .inputValidator((input: CreateReviewInput): CreateReviewInput => {
    if (!input.parkingLotId) throw new Error("주차장 ID 필요");
    if (
      !validateScore(input.entryScore) ||
      !validateScore(input.spaceScore) ||
      !validateScore(input.passageScore) ||
      !validateScore(input.exitScore) ||
      !validateScore(input.overallScore)
    )
      throw new Error("점수는 1-5 정수");
    return input;
  })
  .handler(async ({ data, request }) => {
    const db = getDB();
    const userId = request ? await getSessionUserId(request) : null;

    // 비회원 rate limit: 같은 IP + 주차장에 24시간 내 1건
    let ipHash: string | null = null;
    if (!userId && request) {
      ipHash = await hashIP(getClientIP(request));
      const existing = await db
        .prepare(
          `SELECT COUNT(*) as cnt FROM user_reviews
           WHERE ip_hash = ?1 AND parking_lot_id = ?2
             AND created_at > datetime('now', '-24 hours')`
        )
        .bind(ipHash, data.parkingLotId)
        .first<{ cnt: number }>();
      if (existing && existing.cnt > 0) {
        throw new Error("24시간 내에 같은 주차장에 이미 리뷰를 남겼습니다");
      }
    }

    // 회원 rate limit: 같은 주차장에 24시간 내 1건
    if (userId) {
      const existing = await db
        .prepare(
          `SELECT COUNT(*) as cnt FROM user_reviews
           WHERE user_id = ?1 AND parking_lot_id = ?2
             AND created_at > datetime('now', '-24 hours')`
        )
        .bind(userId, data.parkingLotId)
        .first<{ cnt: number }>();
      if (existing && existing.cnt > 0) {
        throw new Error("24시간 내에 같은 주차장에 이미 리뷰를 남겼습니다");
      }
    }

    await db
      .prepare(
        `INSERT INTO user_reviews (
          parking_lot_id, user_id, guest_nickname, ip_hash,
          entry_score, space_score, passage_score, exit_score,
          overall_score, comment, visited_at
        ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
      )
      .bind(
        data.parkingLotId,
        userId,
        userId ? null : (data.guestNickname || "익명"),
        userId ? null : ipHash,
        data.entryScore,
        data.spaceScore,
        data.passageScore,
        data.exitScore,
        data.overallScore,
        data.comment ?? null,
        data.visitedAt ?? null
      )
      .run();

    return { ok: true };
  });

/** 리뷰 삭제 (본인만) */
export const deleteReview = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { reviewId: number }): { reviewId: number } => input
  )
  .handler(async ({ data, request }) => {
    const userId = request ? await getSessionUserId(request) : null;
    if (!userId) throw new Error("로그인 필요");

    const db = getDB();
    const review = await db
      .prepare("SELECT user_id FROM user_reviews WHERE id = ?1")
      .bind(data.reviewId)
      .first<{ user_id: string | null }>();

    if (!review || review.user_id !== userId) {
      throw new Error("본인 리뷰만 삭제 가능");
    }

    await db
      .prepare("DELETE FROM user_reviews WHERE id = ?1")
      .bind(data.reviewId)
      .run();

    return { ok: true };
  });
