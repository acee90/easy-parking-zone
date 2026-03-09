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
  created_at: string;
  lot_name: string;
  lot_address: string;
}

export interface CafeSignal {
  id: number;
  parkingLotId: string;
  url: string;
  title: string;
  snippet: string;
  aiSentiment: string;
  humanScore: number | null;
  createdAt: string;
  lot: {
    name: string;
    address: string;
  };
}

function rowToSignal(row: SignalRow): CafeSignal {
  return {
    id: row.id,
    parkingLotId: row.parking_lot_id,
    url: row.url,
    title: row.title,
    snippet: row.snippet,
    aiSentiment: row.ai_sentiment,
    humanScore: row.human_score,
    createdAt: row.created_at,
    lot: {
      name: row.lot_name,
      address: row.lot_address,
    },
  };
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
    let paramIdx = 1;

    if (status === "pending") {
      conditions.push(`cs.human_score IS NULL`);
    } else if (status === "tagged") {
      conditions.push(`cs.human_score IS NOT NULL AND cs.human_score > 0`);
    } else if (status === "irrelevant") {
      conditions.push(`cs.human_score = 0`);
    }

    if (lotSearch) {
      conditions.push(`p.name LIKE ?${paramIdx}`);
      params.push(`%${lotSearch}%`);
      paramIdx++;
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await db
      .prepare(`SELECT COUNT(*) as total FROM cafe_signals cs JOIN parking_lots p ON p.id = cs.parking_lot_id ${where}`)
      .bind(...params)
      .first<{ total: number }>();

    const result = await db
      .prepare(
        `SELECT cs.id, cs.parking_lot_id, cs.url, cs.title, cs.snippet,
                cs.ai_sentiment, cs.human_score, cs.created_at,
                p.name as lot_name, p.address as lot_address
         FROM cafe_signals cs
         JOIN parking_lots p ON p.id = cs.parking_lot_id
         ${where}
         ORDER BY cs.id
         LIMIT ?${paramIdx} OFFSET ?${paramIdx + 1}`
      )
      .bind(...params, limit, offset)
      .all<SignalRow>();

    return {
      items: (result.results ?? []).map(rowToSignal),
      total: countResult?.total ?? 0,
      page,
      limit,
    };
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
