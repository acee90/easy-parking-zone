import { createServerFn } from "@tanstack/react-start";
import { setResponseHeader } from "@tanstack/react-start/server";
import { getDb } from "@/db";
import { schema } from "@/db";
import { eq, and, sql } from "drizzle-orm";
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
    const db = getDb();
    const userId = request ? await getSessionUserId(request) : null;
    const anonId = request ? ensureAnonId(request) : null;
    const voterId = resolveVoterId(userId, anonId);

    const counts = await db
      .select({
        upCount: sql<number>`SUM(CASE WHEN ${schema.parkingVotes.voteType} = 'up' THEN 1 ELSE 0 END)`,
        downCount: sql<number>`SUM(CASE WHEN ${schema.parkingVotes.voteType} = 'down' THEN 1 ELSE 0 END)`,
      })
      .from(schema.parkingVotes)
      .where(eq(schema.parkingVotes.parkingLotId, data.parkingLotId))
      .get();

    let myVote: "up" | "down" | null = null;
    let bookmarked = false;

    if (voterId) {
      const vote = await db
        .select({ voteType: schema.parkingVotes.voteType })
        .from(schema.parkingVotes)
        .where(
          and(
            eq(schema.parkingVotes.userId, voterId),
            eq(schema.parkingVotes.parkingLotId, data.parkingLotId),
          )
        )
        .get();
      myVote = (vote?.voteType as "up" | "down") ?? null;
    }

    if (userId) {
      const bm = await db
        .select({ id: schema.parkingBookmarks.id })
        .from(schema.parkingBookmarks)
        .where(
          and(
            eq(schema.parkingBookmarks.userId, userId),
            eq(schema.parkingBookmarks.parkingLotId, data.parkingLotId),
          )
        )
        .get();
      bookmarked = bm !== undefined;
    }

    return {
      upCount: counts?.upCount ?? 0,
      downCount: counts?.downCount ?? 0,
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

    const db = getDb();
    const existing = await db
      .select({ voteType: schema.parkingVotes.voteType })
      .from(schema.parkingVotes)
      .where(
        and(
          eq(schema.parkingVotes.userId, voterId),
          eq(schema.parkingVotes.parkingLotId, data.parkingLotId),
        )
      )
      .get();

    if (existing) {
      if (existing.voteType === data.voteType) {
        await db
          .delete(schema.parkingVotes)
          .where(
            and(
              eq(schema.parkingVotes.userId, voterId),
              eq(schema.parkingVotes.parkingLotId, data.parkingLotId),
            )
          );
      } else {
        await db
          .update(schema.parkingVotes)
          .set({ voteType: data.voteType })
          .where(
            and(
              eq(schema.parkingVotes.userId, voterId),
              eq(schema.parkingVotes.parkingLotId, data.parkingLotId),
            )
          );
      }
    } else {
      await db.insert(schema.parkingVotes).values({
        userId: voterId,
        parkingLotId: data.parkingLotId,
        voteType: data.voteType,
      });
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

    const db = getDb();
    const existing = await db
      .select({ id: schema.parkingBookmarks.id })
      .from(schema.parkingBookmarks)
      .where(
        and(
          eq(schema.parkingBookmarks.userId, userId),
          eq(schema.parkingBookmarks.parkingLotId, data.parkingLotId),
        )
      )
      .get();

    if (existing) {
      await db
        .delete(schema.parkingBookmarks)
        .where(
          and(
            eq(schema.parkingBookmarks.userId, userId),
            eq(schema.parkingBookmarks.parkingLotId, data.parkingLotId),
          )
        );
    } else {
      await db.insert(schema.parkingBookmarks).values({
        userId,
        parkingLotId: data.parkingLotId,
      });
    }

    return { ok: true };
  });
