/**
 * 주차장 하이브리드 매칭 모듈 (Workers Cron용)
 *
 * filter_passed=1인 web_sources_raw를 FTS5로 후보 검색 후:
 *   - high 신뢰도: 바로 web_sources에 저장 (AI 불필요)
 *   - medium 신뢰도: AI 검증 후 저장 (Haiku 1건씩)
 *   - low/none: 스킵
 */
import { getMatchConfidence, stripHtml } from "./lib/scoring";
import { classifyBatch, type AiFilterInput } from "./lib/ai-filter";

const MAX_PER_RUN = 50;
/** FTS 후보 최대 개수 */
const FTS_CANDIDATE_LIMIT = 20;

interface RawRow {
  id: number;
  source: string;
  source_id: string;
  source_url: string;
  title: string;
  content: string;
  author: string | null;
  published_at: string | null;
  sentiment_score: number | null;
  ai_difficulty_keywords: string | null;
  ai_summary: string | null;
}

interface LotRow {
  lot_id: string;
  name: string;
  address: string;
}

const STOP_WORDS = new Set([
  "주차장", "주차", "후기", "정보", "공유", "추천", "이용", "요금",
  "무료", "저렴", "가격", "시간", "위치", "근처", "주변", "최신",
  "리스트", "포함", "안내", "방법", "꿀팁", "총정리", "비교",
  "네이버", "블로그", "카페", "유튜브", "플레이스", "리뷰",
]);

function extractSearchKeywords(title: string, content: string): string[] {
  const text = `${title} ${content}`.slice(0, 500);
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && w.length <= 15)
    .filter((w) => !STOP_WORDS.has(w))
    .filter((w) => !/^\d+$/.test(w));
  return [...new Set(words)].slice(0, 5);
}

async function searchCandidateLots(
  db: D1Database,
  keywords: string[],
): Promise<LotRow[]> {
  if (keywords.length === 0) return [];

  const seen = new Set<string>();
  const results: LotRow[] = [];

  // 1. FTS5 검색
  const ftsQuery = keywords.map((kw) => `"${kw}" OR ${kw}*`).join(" OR ");
  try {
    const ftsRows = await db
      .prepare(
        `SELECT lot_id, name, address FROM parking_lots_fts
         WHERE parking_lots_fts MATCH ?1 LIMIT ?2`,
      )
      .bind(ftsQuery, FTS_CANDIDATE_LIMIT)
      .all<LotRow>();

    for (const row of ftsRows.results ?? []) {
      if (!seen.has(row.lot_id)) {
        seen.add(row.lot_id);
        results.push(row);
      }
    }
  } catch { /* FTS 쿼리 실패 시 폴백으로 */ }

  // 2. LIKE 폴백
  if (results.length < 3) {
    for (const kw of keywords.slice(0, 3)) {
      if (kw.length < 2) continue;
      const likeRows = await db
        .prepare(
          `SELECT id as lot_id, name, address FROM parking_lots
           WHERE name LIKE ?1 LIMIT ?2`,
        )
        .bind(`%${kw}%`, FTS_CANDIDATE_LIMIT - results.length)
        .all<LotRow>();

      for (const row of likeRows.results ?? []) {
        if (!seen.has(row.lot_id)) {
          seen.add(row.lot_id);
          results.push(row);
        }
      }
      if (results.length >= FTS_CANDIDATE_LIMIT) break;
    }
  }

  return results;
}

export async function runMatchBatch(
  db: D1Database,
  env?: { ANTHROPIC_API_KEY?: string },
): Promise<{ matched: number; lotLinks: number; aiVerified: number }> {
  const rows = await db
    .prepare(
      `SELECT id, source, source_id, source_url, title, content, author, published_at,
              sentiment_score, ai_difficulty_keywords, ai_summary
       FROM web_sources_raw
       WHERE filter_passed = 1 AND matched_at IS NULL
       ORDER BY id
       LIMIT ?1`,
    )
    .bind(MAX_PER_RUN)
    .all<RawRow>();

  const sources = rows.results ?? [];
  if (sources.length === 0) return { matched: 0, lotLinks: 0, aiVerified: 0 };

  const insertBatch: D1PreparedStatement[] = [];
  const updateBatch: D1PreparedStatement[] = [];
  let matched = 0;
  let lotLinks = 0;
  let aiVerified = 0;

  for (const raw of sources) {
    const title = stripHtml(raw.title);
    const content = stripHtml(raw.content);

    // 1. FTS로 후보 검색
    const keywords = extractSearchKeywords(title, content);
    const candidates = await searchCandidateLots(db, keywords);

    // 2. 후보별 신뢰도 판정
    const highMatches: Array<{ lot: LotRow; score: number }> = [];
    const mediumMatches: Array<{ lot: LotRow; score: number }> = [];

    for (const lot of candidates) {
      const { score, confidence } = getMatchConfidence(title, content, lot.name, lot.address);
      if (confidence === "high") {
        highMatches.push({ lot, score });
      } else if (confidence === "medium") {
        mediumMatches.push({ lot, score });
      }
      // low, none → 스킵
    }

    // 3. high → 바로 저장
    for (const { lot, score } of highMatches) {
      insertBatch.push(buildInsert(db, raw, lot, score));
      lotLinks++;
    }

    // 4. medium → AI 검증 (API 키가 있을 때만)
    if (mediumMatches.length > 0 && env?.ANTHROPIC_API_KEY) {
      const inputs: AiFilterInput[] = mediumMatches.map(({ lot }) => ({
        parkingName: lot.name,
        title,
        description: content,
      }));

      try {
        const results = await classifyBatch(inputs, env.ANTHROPIC_API_KEY);
        for (let j = 0; j < mediumMatches.length; j++) {
          const { lot, score } = mediumMatches[j];
          const aiResult = results[j];
          if (aiResult?.filterPassed) {
            insertBatch.push(buildInsert(db, raw, lot, score));
            lotLinks++;
            aiVerified++;
          }
        }
      } catch (err) {
        console.log(`[match] AI verify error: ${(err as Error).message}`);
        // AI 실패 시 medium은 스킵
      }
    }

    // matched_at: 매칭이 있을 때만 설정
    if (highMatches.length > 0 || (mediumMatches.length > 0 && env?.ANTHROPIC_API_KEY)) {
      matched++;
      updateBatch.push(
        db
          .prepare("UPDATE web_sources_raw SET matched_at = datetime('now') WHERE id = ?1")
          .bind(raw.id),
      );
    }
  }

  const D1_BATCH_LIMIT = 500;
  const allStatements = [...insertBatch, ...updateBatch];
  for (let i = 0; i < allStatements.length; i += D1_BATCH_LIMIT) {
    await db.batch(allStatements.slice(i, i + D1_BATCH_LIMIT));
  }

  return { matched, lotLinks, aiVerified };
}

function buildInsert(
  db: D1Database,
  raw: RawRow,
  lot: LotRow,
  score: number,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO web_sources
       (parking_lot_id, source, source_id, title, content, source_url,
        author, published_at, relevance_score, raw_source_id,
        filter_passed, filter_removed_by, sentiment_score,
        ai_difficulty_keywords, ai_summary)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, NULL, ?11, ?12, ?13)`,
    )
    .bind(
      lot.lot_id,
      raw.source,
      `${raw.source_id}:${lot.lot_id}`,
      stripHtml(raw.title),
      stripHtml(raw.content),
      raw.source_url,
      raw.author,
      raw.published_at,
      score,
      raw.id,
      raw.sentiment_score,
      raw.ai_difficulty_keywords,
      raw.ai_summary,
    );
}
