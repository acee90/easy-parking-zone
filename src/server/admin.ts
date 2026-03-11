import { createServerFn } from "@tanstack/react-start";
import { getDb } from "@/db";
import { schema } from "@/db";
import { eq, and, sql, count } from "drizzle-orm";
import { createAuth } from "@/lib/auth";

// --- Auth helpers ---

const isDev = process.env.NODE_ENV === "development";

async function getSession(request: Request) {
  try {
    const auth = createAuth();
    return await auth.api.getSession({ headers: request.headers });
  } catch {
    return null;
  }
}

async function requireAdmin(request: Request) {
  if (isDev) return "dev-admin";

  const session = await getSession(request);
  if (!session?.user?.id) throw new Error("로그인 필요");

  const db = getDb();
  const user = await db
    .select({ isAdmin: schema.users.isAdmin })
    .from(schema.users)
    .where(eq(schema.users.id, session.user.id))
    .get();

  if (!user?.isAdmin) throw new Error("관리자 권한 필요");
  return session.user.id;
}

// --- Types ---

export interface LotTag {
  parkingLotId: string;
  name: string;
  address: string;
}

export interface SignalItem {
  id: number;
  title: string;
  url: string;
  snippet: string;
  aiSentiment: string;
  humanScore: number | null;
  lots: LotTag[];
}

// --- Server functions ---

export const checkAdminAccess = createServerFn({ method: "GET" }).handler(
  async ({ request }) => {
    if (isDev) return { isAdmin: true };

    if (!request) return { isAdmin: false };
    const session = await getSession(request);
    if (!session?.user?.id) return { isAdmin: false };

    const db = getDb();
    const user = await db
      .select({ isAdmin: schema.users.isAdmin })
      .from(schema.users)
      .where(eq(schema.users.id, session.user.id))
      .get();

    return { isAdmin: !!user?.isAdmin };
  }
);

/** 시그널 목록 — 동적 WHERE + JOIN이 복잡하여 raw SQL 유지 */
export const fetchSignals = createServerFn({ method: "GET" })
  .inputValidator(
    (input: {
      status?: "pending" | "tagged" | "irrelevant" | "all";
      lotSearch?: string;
      page?: number;
      limit?: number;
    }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const { status = "pending", lotSearch, page = 1, limit = 50 } = data;
    const db = getDb();
    const offset = (page - 1) * limit;

    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (status === "pending") {
      conditions.push("cs.human_score IS NULL");
    } else if (status === "tagged") {
      conditions.push("cs.human_score IS NOT NULL AND cs.human_score > 0");
    } else if (status === "irrelevant") {
      conditions.push("cs.human_score = 0");
    }

    let joinClause = "";
    if (lotSearch) {
      joinClause = `
        JOIN cafe_signal_lots csl_f ON csl_f.signal_id = cs.id
        JOIN parking_lots p_f ON p_f.id = csl_f.parking_lot_id`;
      conditions.push(`p_f.name LIKE ?${idx}`);
      params.push(`%${lotSearch}%`);
      idx++;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Count
    const countRows = await db.all(
      sql.raw(
        `SELECT COUNT(DISTINCT cs.id) as total
         FROM cafe_signals cs ${joinClause} ${where}`
      )
    );
    const total = (countRows[0] as { total: number } | undefined)?.total ?? 0;

    // Paginated signals
    params.push(limit, offset);
    const signals = await db.all(
      sql.raw(
        `SELECT DISTINCT cs.id, cs.title, cs.url, cs.snippet,
                cs.ai_sentiment, cs.human_score
         FROM cafe_signals cs ${joinClause} ${where}
         ORDER BY cs.id
         LIMIT ?${idx} OFFSET ?${idx + 1}`
      )
    ) as unknown as {
      id: number;
      title: string;
      url: string;
      snippet: string;
      ai_sentiment: string;
      human_score: number | null;
    }[];

    if (signals.length === 0) {
      return {
        items: [] as SignalItem[],
        total,
        page,
        limit,
      };
    }

    // Fetch lots for these signals
    const ids = signals.map((s) => s.id);
    const ph = ids.map((_, i) => `?${i + 1}`).join(",");
    const lotRows = await db.all(
      sql.raw(
        `SELECT csl.signal_id, csl.parking_lot_id, p.name, p.address
         FROM cafe_signal_lots csl
         JOIN parking_lots p ON p.id = csl.parking_lot_id
         WHERE csl.signal_id IN (${ph})`
      )
    ) as unknown as {
      signal_id: number;
      parking_lot_id: string;
      name: string;
      address: string;
    }[];

    const lotsMap = new Map<number, LotTag[]>();
    for (const row of lotRows) {
      const arr = lotsMap.get(row.signal_id) ?? [];
      arr.push({
        parkingLotId: row.parking_lot_id,
        name: row.name,
        address: row.address,
      });
      lotsMap.set(row.signal_id, arr);
    }

    const items: SignalItem[] = signals.map((s) => ({
      id: s.id,
      title: s.title,
      url: s.url,
      snippet: s.snippet,
      aiSentiment: s.ai_sentiment,
      humanScore: s.human_score,
      lots: lotsMap.get(s.id) ?? [],
    }));

    return { items, total, page, limit };
  });

export const tagSignal = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { signalId: number; humanScore: number | null }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDb();
    await db
      .update(schema.cafeSignals)
      .set({ humanScore: data.humanScore, updatedAt: sql`datetime('now')` })
      .where(eq(schema.cafeSignals.id, data.signalId));

    return { ok: true };
  });

export const removeLotFromSignal = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { signalId: number; parkingLotId: string }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDb();
    await db
      .delete(schema.cafeSignalLots)
      .where(
        and(
          eq(schema.cafeSignalLots.signalId, data.signalId),
          eq(schema.cafeSignalLots.parkingLotId, data.parkingLotId),
        )
      );

    return { ok: true };
  });

export const addLotToSignal = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { signalId: number; parkingLotId: string }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDb();
    await db
      .insert(schema.cafeSignalLots)
      .values({ signalId: data.signalId, parkingLotId: data.parkingLotId })
      .onConflictDoNothing();

    const lot = await db
      .select({ name: schema.parkingLots.name, address: schema.parkingLots.address })
      .from(schema.parkingLots)
      .where(eq(schema.parkingLots.id, data.parkingLotId))
      .get();

    return {
      lot: {
        parkingLotId: data.parkingLotId,
        name: lot?.name ?? "",
        address: lot?.address ?? "",
      },
    };
  });

export const searchParkingLots = createServerFn({ method: "GET" })
  .inputValidator((input: { query: string }) => input)
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDb();
    const q = `%${data.query}%`;
    const rows = await db
      .select({
        id: schema.parkingLots.id,
        name: schema.parkingLots.name,
        address: schema.parkingLots.address,
      })
      .from(schema.parkingLots)
      .where(
        sql`${schema.parkingLots.name} LIKE ${q} OR ${schema.parkingLots.address} LIKE ${q}`
      )
      .orderBy(schema.parkingLots.name)
      .limit(10);

    return rows;
  });

// --- 리뷰 모니터링 ---

export type ReviewSource = "user" | "clien" | "all";

export interface AdminReviewItem {
  id: number;
  parkingLotId: string;
  parkingLotName: string;
  authorName: string;
  source: string;
  overallScore: number | null;
  comment: string | null;
  sourceUrl: string | null;
  createdAt: string;
}

/** 리뷰 목록 — 동적 WHERE + 복합 JOIN으로 raw SQL 유지 */
export const fetchRecentReviews = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { page?: number; limit?: number; source?: ReviewSource }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const { page = 1, limit = 30, source = "all" } = data;
    const offset = (page - 1) * limit;
    const db = getDb();

    const cond = source === "user"
      ? "r.source_type IS NULL"
      : source === "clien"
        ? "r.source_type = 'clien'"
        : "1=1";

    const countRows = await db.all(
      sql.raw(`SELECT COUNT(*) as total FROM user_reviews r WHERE ${cond}`)
    );
    const total = (countRows[0] as { total: number } | undefined)?.total ?? 0;

    const rows = await db.all(
      sql`SELECT r.id, r.parking_lot_id, p.name as lot_name,
              COALESCE(u.name, r.guest_nickname, '익명') as author_name,
              COALESCE(r.source_type, 'user') as source,
              r.overall_score, r.comment, r.source_url, r.created_at
       FROM user_reviews r
       JOIN parking_lots p ON p.id = r.parking_lot_id
       LEFT JOIN user u ON u.id = r.user_id
       WHERE ${sql.raw(cond)}
       ORDER BY r.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`
    );

    const items: AdminReviewItem[] = (rows as unknown as {
      id: number;
      parking_lot_id: string;
      lot_name: string;
      author_name: string;
      source: string;
      overall_score: number | null;
      comment: string | null;
      source_url: string | null;
      created_at: string;
    }[]).map((r) => ({
      id: r.id,
      parkingLotId: r.parking_lot_id,
      parkingLotName: r.lot_name,
      authorName: r.author_name,
      source: r.source,
      overallScore: r.overall_score,
      comment: r.comment,
      sourceUrl: r.source_url,
      createdAt: r.created_at,
    }));

    return { items, total, page, limit };
  });

export const fetchReviewStats = createServerFn({ method: "GET" }).handler(
  async ({ request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDb();
    const rows = await db.all(
      sql`SELECT COALESCE(source_type, 'user') as source, COUNT(*) as cnt
       FROM user_reviews GROUP BY source`
    );

    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows as unknown as { source: string; cnt: number }[]) {
      counts[r.source] = r.cnt;
      total += r.cnt;
    }

    return { total, counts };
  }
);

export const adminDeleteReview = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { reviewId: number }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDb();
    await db
      .delete(schema.userReviews)
      .where(eq(schema.userReviews.id, data.reviewId));

    return { ok: true };
  });

// --- 웹 소스 관리 ---

export type WebSourceType = "naver_blog" | "naver_cafe" | "poi" | "youtube_comment" | "naver_place" | "all";

export interface WebSourceItem {
  id: number;
  parkingLotName: string;
  source: string;
  author: string | null;
  title: string | null;
  content: string | null;
  sourceUrl: string | null;
  crawledAt: string;
}

/** 웹 소스 목록 — 동적 WHERE로 raw SQL 유지 */
export const fetchWebSources = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { page?: number; limit?: number; source?: WebSourceType }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const { page = 1, limit = 30, source = "all" } = data;
    const offset = (page - 1) * limit;
    const db = getDb();

    const cond = source === "all" ? "1=1" : `ws.source = '${source}'`;

    const countRows = await db.all(
      sql.raw(`SELECT COUNT(*) as total FROM web_sources ws WHERE ${cond}`)
    );
    const total = (countRows[0] as { total: number } | undefined)?.total ?? 0;

    const rows = await db.all(
      sql`SELECT ws.id, p.name as lot_name, ws.source,
              ws.author, ws.title, ws.content, ws.source_url, ws.crawled_at
       FROM web_sources ws
       JOIN parking_lots p ON p.id = ws.parking_lot_id
       WHERE ${sql.raw(cond)}
       ORDER BY ws.crawled_at DESC
       LIMIT ${limit} OFFSET ${offset}`
    );

    const items: WebSourceItem[] = (rows as unknown as {
      id: number;
      lot_name: string;
      source: string;
      author: string | null;
      title: string | null;
      content: string | null;
      source_url: string | null;
      crawled_at: string;
    }[]).map((r) => ({
      id: r.id,
      parkingLotName: r.lot_name,
      source: r.source,
      author: r.author,
      title: r.title,
      content: r.content,
      sourceUrl: r.source_url,
      crawledAt: r.crawled_at,
    }));

    return { items, total, page, limit };
  });

export const fetchWebSourceStats = createServerFn({ method: "GET" }).handler(
  async ({ request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDb();
    const rows = await db.all(
      sql`SELECT source, COUNT(*) as cnt FROM web_sources GROUP BY source`
    );

    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of rows as unknown as { source: string; cnt: number }[]) {
      counts[r.source] = r.cnt;
      total += r.cnt;
    }
    return { total, counts };
  }
);

export const adminDeleteWebSource = createServerFn({ method: "POST" })
  .inputValidator((input: { id: number }) => input)
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDb();
    await db
      .delete(schema.webSources)
      .where(eq(schema.webSources.id, data.id));
    return { ok: true };
  });

// --- POI 매칭 실패 관리 ---

export type UnmatchedStatus = "pending" | "resolved" | "ignored" | "all";

export interface UnmatchedItem {
  id: number;
  poiName: string;
  lotName: string;
  poiLat: number;
  poiLng: number;
  category: string | null;
  status: string;
  resolvedLotId: string | null;
  resolvedLotName: string | null;
  createdAt: string;
}

/** POI 매칭 실패 목록 — 동적 WHERE + LEFT JOIN으로 raw SQL 유지 */
export const fetchUnmatched = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { status?: UnmatchedStatus; page?: number; limit?: number }) => input,
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const { status = "pending", page = 1, limit = 50 } = data;
    const offset = (page - 1) * limit;
    const db = getDb();

    const cond = status === "all" ? "1=1" : `u.status = '${status}'`;

    const countRows = await db.all(
      sql.raw(`SELECT COUNT(*) as total FROM poi_unmatched u WHERE ${cond}`)
    );
    const total = (countRows[0] as { total: number } | undefined)?.total ?? 0;

    const rows = await db.all(
      sql`SELECT u.id, u.poi_name, u.lot_name, u.poi_lat, u.poi_lng,
              u.category, u.status, u.resolved_lot_id,
              p.name as resolved_lot_name, u.created_at
       FROM poi_unmatched u
       LEFT JOIN parking_lots p ON p.id = u.resolved_lot_id
       WHERE ${sql.raw(cond)}
       ORDER BY u.created_at DESC
       LIMIT ${limit} OFFSET ${offset}`
    );

    const items: UnmatchedItem[] = (rows as unknown as {
      id: number;
      poi_name: string;
      lot_name: string;
      poi_lat: number;
      poi_lng: number;
      category: string | null;
      status: string;
      resolved_lot_id: string | null;
      resolved_lot_name: string | null;
      created_at: string;
    }[]).map((r) => ({
      id: r.id,
      poiName: r.poi_name,
      lotName: r.lot_name,
      poiLat: r.poi_lat,
      poiLng: r.poi_lng,
      category: r.category,
      status: r.status,
      resolvedLotId: r.resolved_lot_id,
      resolvedLotName: r.resolved_lot_name,
      createdAt: r.created_at,
    }));

    return { items, total, page, limit };
  });

export const fetchUnmatchedStats = createServerFn({ method: "GET" }).handler(
  async ({ request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDb();
    const stats = await db
      .select({
        total: count(),
        pending: sql<number>`SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END)`,
        resolved: sql<number>`SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END)`,
        ignored: sql<number>`SUM(CASE WHEN status = 'ignored' THEN 1 ELSE 0 END)`,
      })
      .from(schema.poiUnmatched)
      .get();

    return stats ?? { total: 0, pending: 0, resolved: 0, ignored: 0 };
  },
);

export const resolveUnmatched = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { id: number; parkingLotId: string }) => input,
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDb();
    await db
      .update(schema.poiUnmatched)
      .set({
        status: "resolved",
        resolvedLotId: data.parkingLotId,
        updatedAt: sql`datetime('now')`,
      })
      .where(eq(schema.poiUnmatched.id, data.id));

    return { ok: true };
  });

export const ignoreUnmatched = createServerFn({ method: "POST" })
  .inputValidator((input: { id: number }) => input)
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDb();
    await db
      .update(schema.poiUnmatched)
      .set({ status: "ignored", updatedAt: sql`datetime('now')` })
      .where(eq(schema.poiUnmatched.id, data.id));

    return { ok: true };
  });

export const fetchSignalStats = createServerFn({ method: "GET" }).handler(
  async ({ request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDb();
    const stats = await db
      .select({
        total: count(),
        pending: sql<number>`SUM(CASE WHEN human_score IS NULL THEN 1 ELSE 0 END)`,
        tagged: sql<number>`SUM(CASE WHEN human_score IS NOT NULL AND human_score > 0 THEN 1 ELSE 0 END)`,
        irrelevant: sql<number>`SUM(CASE WHEN human_score = 0 THEN 1 ELSE 0 END)`,
      })
      .from(schema.cafeSignals)
      .get();

    return stats ?? { total: 0, pending: 0, tagged: 0, irrelevant: 0 };
  }
);
