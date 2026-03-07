import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { getDB } from "@/lib/db";
import { createAuth } from "@/lib/auth";
import { getAnonIdFromRequest, resolveVoterId, generateAnonId, buildAnonCookieValue } from "@/lib/vote-utils";

async function getSessionUserId(request: Request): Promise<string | null> {
  try {
    const auth = createAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

/** 익명 ID가 없으면 생성하고 HttpOnly 쿠키로 설정 */
function ensureAnonId(request: Request): string {
  const existing = getAnonIdFromRequest(request);
  if (existing) return existing;
  const anonId = generateAnonId();
  setResponseHeader("Set-Cookie", buildAnonCookieValue(anonId));
  return anonId;
}

export interface VoteSummary {
  upCount: number;
  downCount: number;
  myVote: "up" | "down" | null;
  bookmarked: boolean;
}

/** 주차장 투표/북마크 현황 조회 */
export const fetchVoteSummary = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { parkingLotId: string }): { parkingLotId: string } => input
  )
  .handler(async ({ data, request }): Promise<VoteSummary> => {
    const db = getDB();
    const userId = request ? await getSessionUserId(request) : null;
    const anonId = request ? ensureAnonId(request) : null;
    const voterId = resolveVoterId(userId, anonId);

    const counts = await db
      .prepare(
        `SELECT
          SUM(CASE WHEN vote_type = 'up' THEN 1 ELSE 0 END) as up_count,
          SUM(CASE WHEN vote_type = 'down' THEN 1 ELSE 0 END) as down_count
        FROM parking_votes
        WHERE parking_lot_id = ?1`
      )
      .bind(data.parkingLotId)
      .first<{ up_count: number; down_count: number }>();

    let myVote: "up" | "down" | null = null;
    let bookmarked = false;

    if (voterId) {
      const vote = await db
        .prepare(
          "SELECT vote_type FROM parking_votes WHERE user_id = ?1 AND parking_lot_id = ?2"
        )
        .bind(voterId, data.parkingLotId)
        .first<{ vote_type: string }>();
      myVote = (vote?.vote_type as "up" | "down") ?? null;
    }

    if (userId) {
      const bm = await db
        .prepare(
          "SELECT 1 FROM parking_bookmarks WHERE user_id = ?1 AND parking_lot_id = ?2"
        )
        .bind(userId, data.parkingLotId)
        .first();
      bookmarked = bm !== null;
    }

    return {
      upCount: counts?.up_count ?? 0,
      downCount: counts?.down_count ?? 0,
      myVote,
      bookmarked,
    };
  });

/** 투표 토글 (같은 타입 재클릭 시 취소, 다른 타입 클릭 시 변경) */
export const toggleVote = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { parkingLotId: string; voteType: "up" | "down" }): {
      parkingLotId: string;
      voteType: "up" | "down";
    } => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("투표할 수 없습니다");
    const userId = await getSessionUserId(request);
    const anonId = ensureAnonId(request);
    const voterId = resolveVoterId(userId, anonId);
    if (!voterId) throw new Error("투표할 수 없습니다");

    const db = getDB();
    const existing = await db
      .prepare(
        "SELECT vote_type FROM parking_votes WHERE user_id = ?1 AND parking_lot_id = ?2"
      )
      .bind(voterId, data.parkingLotId)
      .first<{ vote_type: string }>();

    if (existing) {
      if (existing.vote_type === data.voteType) {
        await db
          .prepare(
            "DELETE FROM parking_votes WHERE user_id = ?1 AND parking_lot_id = ?2"
          )
          .bind(voterId, data.parkingLotId)
          .run();
      } else {
        await db
          .prepare(
            "UPDATE parking_votes SET vote_type = ?3 WHERE user_id = ?1 AND parking_lot_id = ?2"
          )
          .bind(voterId, data.parkingLotId, data.voteType)
          .run();
      }
    } else {
      await db
        .prepare(
          "INSERT INTO parking_votes (user_id, parking_lot_id, vote_type) VALUES (?1, ?2, ?3)"
        )
        .bind(voterId, data.parkingLotId, data.voteType)
        .run();
    }

    return { ok: true };
  });

/** 북마크 토글 */
export const toggleBookmark = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { parkingLotId: string }): { parkingLotId: string } => input
  )
  .handler(async ({ data, request }) => {
    const userId = request ? await getSessionUserId(request) : null;
    if (!userId) throw new Error("로그인 필요");

    const db = getDB();
    const existing = await db
      .prepare(
        "SELECT 1 FROM parking_bookmarks WHERE user_id = ?1 AND parking_lot_id = ?2"
      )
      .bind(userId, data.parkingLotId)
      .first();

    if (existing) {
      await db
        .prepare(
          "DELETE FROM parking_bookmarks WHERE user_id = ?1 AND parking_lot_id = ?2"
        )
        .bind(userId, data.parkingLotId)
        .run();
    } else {
      await db
        .prepare(
          "INSERT INTO parking_bookmarks (user_id, parking_lot_id) VALUES (?1, ?2)"
        )
        .bind(userId, data.parkingLotId)
        .run();
    }

    return { ok: true };
  });
