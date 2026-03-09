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

interface SignalRow {
  id: number;
  parking_lot_id: string;
  url: string;
  title: string;
  snippet: string;
  ai_sentiment: string;
  human_score: number | null;
  lot_name: string;
  lot_address: string;
}

export interface LotTag {
  parkingLotId: string;
  name: string;
  address: string;
  count: number;
}

export interface GroupedSignal {
  title: string;
  snippet: string;
  aiSentiment: string;
  humanScore: number | null;
  urls: string[];
  lots: LotTag[];
  signalIds: number[];
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

export const fetchGroupedSignals = createServerFn({ method: "GET" })
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

    // Build dynamic query parts
    const where: string[] = [];
    const binds: unknown[] = [];
    let idx = 1;

    if (lotSearch) {
      where.push(`p.name LIKE ?${idx}`);
      binds.push(`%${lotSearch}%`);
      idx++;
    }

    const whereClause =
      where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";

    let having = "";
    if (status === "pending") {
      having =
        "HAVING SUM(CASE WHEN cs.human_score IS NOT NULL THEN 1 ELSE 0 END) = 0";
    } else if (status === "tagged") {
      having =
        "HAVING SUM(CASE WHEN cs.human_score > 0 THEN 1 ELSE 0 END) > 0";
    } else if (status === "irrelevant") {
      having =
        "HAVING SUM(CASE WHEN cs.human_score = 0 THEN 1 ELSE 0 END) > 0";
    }

    // Count unique title groups
    const countResult = await db
      .prepare(
        `SELECT COUNT(*) as total FROM (
           SELECT cs.title
           FROM cafe_signals cs
           JOIN parking_lots p ON p.id = cs.parking_lot_id
           ${whereClause}
           GROUP BY cs.title
           ${having}
         )`
      )
      .bind(...binds)
      .first<{ total: number }>();

    // Get paginated title groups
    const titlesResult = await db
      .prepare(
        `SELECT cs.title
         FROM cafe_signals cs
         JOIN parking_lots p ON p.id = cs.parking_lot_id
         ${whereClause}
         GROUP BY cs.title
         ${having}
         ORDER BY MIN(cs.id)
         LIMIT ?${idx} OFFSET ?${idx + 1}`
      )
      .bind(...binds, limit, offset)
      .all<{ title: string }>();

    const titles: string[] =
      titlesResult.results?.map((r: { title: string }) => r.title) ?? [];

    if (titles.length === 0) {
      return { items: [] as GroupedSignal[], total: countResult?.total ?? 0, page, limit };
    }

    // Fetch all rows for these title groups
    const ph = titles.map((_: string, i: number) => `?${i + 1}`).join(",");
    const dataResult = await db
      .prepare(
        `SELECT cs.id, cs.parking_lot_id, cs.url, cs.title, cs.snippet,
                cs.ai_sentiment, cs.human_score,
                p.name as lot_name, p.address as lot_address
         FROM cafe_signals cs
         JOIN parking_lots p ON p.id = cs.parking_lot_id
         WHERE cs.title IN (${ph})
         ORDER BY cs.title, cs.id`
      )
      .bind(...titles)
      .all<SignalRow>();

    // Group by title
    const groupMap = new Map<string, GroupedSignal>();
    for (const row of dataResult.results ?? []) {
      let group = groupMap.get(row.title);
      if (!group) {
        group = {
          title: row.title,
          snippet: row.snippet,
          aiSentiment: row.ai_sentiment,
          humanScore: row.human_score,
          urls: [],
          lots: [],
          signalIds: [],
        };
        groupMap.set(row.title, group);
      }

      group.signalIds.push(row.id);
      if (!group.urls.includes(row.url)) group.urls.push(row.url);
      if (row.human_score !== null && group.humanScore === null) {
        group.humanScore = row.human_score;
      }

      const existing = group.lots.find(
        (l) => l.parkingLotId === row.parking_lot_id
      );
      if (existing) {
        existing.count++;
      } else {
        group.lots.push({
          parkingLotId: row.parking_lot_id,
          name: row.lot_name,
          address: row.lot_address,
          count: 1,
        });
      }
    }

    const items = titles
      .map((t: string) => groupMap.get(t))
      .filter((g: GroupedSignal | undefined): g is GroupedSignal => g !== undefined);

    return { items, total: countResult?.total ?? 0, page, limit };
  });

export const tagGroup = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { title: string; humanScore: number | null }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDB();
    await db
      .prepare(
        "UPDATE cafe_signals SET human_score = ?1, updated_at = datetime('now') WHERE title = ?2"
      )
      .bind(data.humanScore, data.title)
      .run();

    return { ok: true };
  });

export const removeLotFromGroup = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { title: string; parkingLotId: string }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDB();
    const result = await db
      .prepare(
        "DELETE FROM cafe_signals WHERE title = ?1 AND parking_lot_id = ?2"
      )
      .bind(data.title, data.parkingLotId)
      .run();

    return { deleted: result.meta.changes ?? 0 };
  });

export const addLotToGroup = createServerFn({ method: "POST" })
  .inputValidator(
    (input: { title: string; parkingLotId: string }) => input
  )
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDB();

    const existing = await db
      .prepare(
        "SELECT url, snippet, ai_sentiment FROM cafe_signals WHERE title = ?1 LIMIT 1"
      )
      .bind(data.title)
      .first<{ url: string; snippet: string; ai_sentiment: string }>();

    if (!existing) throw new Error("시그널을 찾을 수 없습니다");

    await db
      .prepare(
        `INSERT OR IGNORE INTO cafe_signals
         (parking_lot_id, url, title, snippet, ai_sentiment, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, datetime('now'), datetime('now'))`
      )
      .bind(
        data.parkingLotId,
        existing.url,
        data.title,
        existing.snippet,
        existing.ai_sentiment
      )
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

export const deduplicateGroup = createServerFn({ method: "POST" })
  .inputValidator((input: { title: string }) => input)
  .handler(async ({ data, request }) => {
    if (!request) throw new Error("서버 요청 필요");
    await requireAdmin(request);

    const db = getDB();
    const result = await db
      .prepare(
        `DELETE FROM cafe_signals
         WHERE title = ?1
         AND id NOT IN (
           SELECT MIN(id) FROM cafe_signals WHERE title = ?1 GROUP BY parking_lot_id
         )`
      )
      .bind(data.title)
      .run();

    return { deleted: result.meta.changes ?? 0 };
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
