import { createServerFn } from "@tanstack/react-start";
import { getDB } from "@/lib/db";
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

  const db = getDB();
  const user = await db
    .prepare("SELECT is_admin FROM user WHERE id = ?1")
    .bind(session.user.id)
    .first<{ is_admin: number }>();

  if (!user?.is_admin) throw new Error("관리자 권한 필요");
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

    const db = getDB();
    const user = await db
      .prepare("SELECT is_admin FROM user WHERE id = ?1")
      .bind(session.user.id)
      .first<{ is_admin: number }>();

    return { isAdmin: !!user?.is_admin };
  }
);

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
    const db = getDB();
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
    const countResult = await db
      .prepare(
        `SELECT COUNT(DISTINCT cs.id) as total
         FROM cafe_signals cs ${joinClause} ${where}`
      )
      .bind(...params)
      .first<{ total: number }>();

    // Paginated signals
    const signalsResult = await db
      .prepare(
        `SELECT DISTINCT cs.id, cs.title, cs.url, cs.snippet,
                cs.ai_sentiment, cs.human_score
         FROM cafe_signals cs ${joinClause} ${where}
         ORDER BY cs.id
         LIMIT ?${idx} OFFSET ?${idx + 1}`
      )
      .bind(...params, limit, offset)
      .all<{
        id: number;
        title: string;
        url: string;
        snippet: string;
        ai_sentiment: string;
        human_score: number | null;
      }>();

    const signals = signalsResult.results ?? [];
    if (signals.length === 0) {
      return {
        items: [] as SignalItem[],
        total: countResult?.total ?? 0,
        page,
        limit,
      };
    }

    // Fetch lots for these signals
    const ids = signals.map((s: { id: number }) => s.id);
    const ph = ids.map((_: number, i: number) => `?${i + 1}`).join(",");
    const lotsResult = await db
      .prepare(
        `SELECT csl.signal_id, csl.parking_lot_id, p.name, p.address
         FROM cafe_signal_lots csl
         JOIN parking_lots p ON p.id = csl.parking_lot_id
         WHERE csl.signal_id IN (${ph})`
      )
      .bind(...ids)
      .all<{
        signal_id: number;
        parking_lot_id: string;
        name: string;
        address: string;
      }>();

    const lotsMap = new Map<number, LotTag[]>();
    for (const row of lotsResult.results ?? []) {
      const arr = lotsMap.get(row.signal_id) ?? [];
      arr.push({
        parkingLotId: row.parking_lot_id,
        name: row.name,
        address: row.address,
      });
      lotsMap.set(row.signal_id, arr);
    }

    const items: SignalItem[] = signals.map(
      (s: {
        id: number;
        title: string;
        url: string;
        snippet: string;
        ai_sentiment: string;
        human_score: number | null;
      }) => ({
        id: s.id,
        title: s.title,
        url: s.url,
        snippet: s.snippet,
        aiSentiment: s.ai_sentiment,
        humanScore: s.human_score,
        lots: lotsMap.get(s.id) ?? [],
      })
    );

    return { items, total: countResult?.total ?? 0, page, limit };
  });

export const tagSignal = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { signalId: number; humanScore: number | null }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDB();
    await db
      .prepare(
        "UPDATE cafe_signals SET human_score = ?1, updated_at = datetime('now') WHERE id = ?2"
      )
      .bind(data.humanScore, data.signalId)
      .run();

    return { ok: true };
  });

export const removeLotFromSignal = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { signalId: number; parkingLotId: string }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDB();
    await db
      .prepare(
        "DELETE FROM cafe_signal_lots WHERE signal_id = ?1 AND parking_lot_id = ?2"
      )
      .bind(data.signalId, data.parkingLotId)
      .run();

    return { ok: true };
  });

export const addLotToSignal = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { signalId: number; parkingLotId: string }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDB();
    await db
      .prepare(
        "INSERT OR IGNORE INTO cafe_signal_lots (signal_id, parking_lot_id) VALUES (?1, ?2)"
      )
      .bind(data.signalId, data.parkingLotId)
      .run();

    const lot = await db
      .prepare("SELECT name, address FROM parking_lots WHERE id = ?1")
      .bind(data.parkingLotId)
      .first<{ name: string; address: string }>();

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

    const db = getDB();
    const result = await db
      .prepare(
        `SELECT id, name, address FROM parking_lots
         WHERE name LIKE ?1 OR address LIKE ?1
         ORDER BY name LIMIT 10`
      )
      .bind(`%${data.query}%`)
      .all<{ id: string; name: string; address: string }>();

    return result.results ?? [];
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

export const fetchRecentReviews = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { page?: number; limit?: number; source?: ReviewSource }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const { page = 1, limit = 30, source = "all" } = data;
    const offset = (page - 1) * limit;
    const db = getDB();

    const cond = source === "user"
      ? "r.source_type IS NULL"
      : source === "clien"
        ? "r.source_type = 'clien'"
        : "1=1";

    const countRow = await db
      .prepare(`SELECT COUNT(*) as total FROM user_reviews r WHERE ${cond}`)
      .first<{ total: number }>();

    const rows = await db
      .prepare(
        `SELECT r.id, r.parking_lot_id, p.name as lot_name,
                COALESCE(u.name, r.guest_nickname, '익명') as author_name,
                COALESCE(r.source_type, 'user') as source,
                r.overall_score, r.comment, r.source_url, r.created_at
         FROM user_reviews r
         JOIN parking_lots p ON p.id = r.parking_lot_id
         LEFT JOIN user u ON u.id = r.user_id
         WHERE ${cond}
         ORDER BY r.created_at DESC
         LIMIT ?1 OFFSET ?2`
      )
      .bind(limit, offset)
      .all<{
        id: number;
        parking_lot_id: string;
        lot_name: string;
        author_name: string;
        source: string;
        overall_score: number | null;
        comment: string | null;
        source_url: string | null;
        created_at: string;
      }>();

    const items: AdminReviewItem[] = (rows.results ?? []).map((r) => ({
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

    return { items, total: countRow?.total ?? 0, page, limit };
  });

export const fetchReviewStats = createServerFn({ method: "GET" }).handler(
  async ({ request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDB();
    const result = await db
      .prepare(
        `SELECT COALESCE(source_type, 'user') as source, COUNT(*) as cnt
         FROM user_reviews GROUP BY source`
      )
      .all<{ source: string; cnt: number }>();

    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of result.results ?? []) {
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

    const db = getDB();
    await db
      .prepare("DELETE FROM user_reviews WHERE id = ?1")
      .bind(data.reviewId)
      .run();

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

export const fetchWebSources = createServerFn({ method: "GET" })
  .inputValidator(
    (input: { page?: number; limit?: number; source?: WebSourceType }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const { page = 1, limit = 30, source = "all" } = data;
    const offset = (page - 1) * limit;
    const db = getDB();

    const cond = source === "all" ? "1=1" : "ws.source = ?1";
    const bindParams = source === "all" ? [limit, offset] : [source, limit, offset];
    const limitIdx = source === "all" ? "?1" : "?2";
    const offsetIdx = source === "all" ? "?2" : "?3";

    const countRow = await db
      .prepare(`SELECT COUNT(*) as total FROM web_sources ws WHERE ${cond}`)
      .bind(...(source === "all" ? [] : [source]))
      .first<{ total: number }>();

    const rows = await db
      .prepare(
        `SELECT ws.id, p.name as lot_name, ws.source,
                ws.author, ws.title, ws.content, ws.source_url, ws.crawled_at
         FROM web_sources ws
         JOIN parking_lots p ON p.id = ws.parking_lot_id
         WHERE ${cond}
         ORDER BY ws.crawled_at DESC
         LIMIT ${limitIdx} OFFSET ${offsetIdx}`
      )
      .bind(...bindParams)
      .all<{
        id: number;
        lot_name: string;
        source: string;
        author: string | null;
        title: string | null;
        content: string | null;
        source_url: string | null;
        crawled_at: string;
      }>();

    const items: WebSourceItem[] = (rows.results ?? []).map((r) => ({
      id: r.id,
      parkingLotName: r.lot_name,
      source: r.source,
      author: r.author,
      title: r.title,
      content: r.content,
      sourceUrl: r.source_url,
      crawledAt: r.crawled_at,
    }));

    return { items, total: countRow?.total ?? 0, page, limit };
  });

export const fetchWebSourceStats = createServerFn({ method: "GET" }).handler(
  async ({ request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDB();
    const result = await db
      .prepare("SELECT source, COUNT(*) as cnt FROM web_sources GROUP BY source")
      .all<{ source: string; cnt: number }>();

    const counts: Record<string, number> = {};
    let total = 0;
    for (const r of result.results ?? []) {
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

    const db = getDB();
    await db.prepare("DELETE FROM web_sources WHERE id = ?1").bind(data.id).run();
    return { ok: true };
  });

export const fetchSignalStats = createServerFn({ method: "GET" }).handler(
  async ({ request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDB();
    const stats = await db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN human_score IS NULL THEN 1 ELSE 0 END) as pending,
           SUM(CASE WHEN human_score IS NOT NULL AND human_score > 0 THEN 1 ELSE 0 END) as tagged,
           SUM(CASE WHEN human_score = 0 THEN 1 ELSE 0 END) as irrelevant
         FROM cafe_signals`
      )
      .first<{
        total: number;
        pending: number;
        tagged: number;
        irrelevant: number;
      }>();

    return stats ?? { total: 0, pending: 0, tagged: 0, irrelevant: 0 };
  }
);
