/**
 * 주차장 매칭 모듈 (Workers Cron용)
 *
 * filter_passed=1이면서 미매칭인 web_sources_raw를
 * FTS5 인덱스로 후보 주차장을 빠르게 검색한 뒤
 * scoreBlogRelevance로 정밀 채점하여 web_sources에 INSERT.
 *
 * 풀스캔(34K lots × N raw) 대신 FTS 검색(~5건 후보)으로 O(1) 매칭.
 */
import { scoreBlogRelevance, stripHtml } from "./lib/scoring";

const MAX_PER_RUN = 50;
const RELEVANCE_THRESHOLD = 60;
/** FTS 후보 최대 개수 (너무 많으면 의미 없음) */
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

/**
 * 글 제목+내용에서 FTS 검색용 키워드를 추출한다.
 *
 * "코엑스 지하주차장 후기" → ["코엑스"]
 * "강남역 롯데백화점 주차 꿀팁" → ["강남역", "롯데백화점"]
 *
 * 2글자 이상 명사성 단어만 추출, 불용어 제거.
 */
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
    .filter((w) => !/^\d+$/.test(w)); // 숫자만인 것 제외

  // 중복 제거 + 최대 5개
  return [...new Set(words)].slice(0, 5);
}

/**
 * FTS5 + LIKE 폴백으로 후보 주차장을 검색한다.
 *
 * 1. FTS5: 키워드 OR 검색 (정확한 토큰 매칭, 빠름)
 * 2. LIKE 폴백: FTS에서 못 찾으면 부분 문자열 매칭 (느리지만 확실)
 */
async function searchCandidateLots(
  db: D1Database,
  keywords: string[],
): Promise<LotRow[]> {
  if (keywords.length === 0) return [];

  const seen = new Set<string>();
  const results: LotRow[] = [];

  // 1. FTS5 검색 (prefix 매칭 포함)
  const ftsQuery = keywords.map((kw) => `"${kw}" OR ${kw}*`).join(" OR ");
  try {
    const ftsRows = await db
      .prepare(
        `SELECT lot_id, name, address
         FROM parking_lots_fts
         WHERE parking_lots_fts MATCH ?1
         LIMIT ?2`,
      )
      .bind(ftsQuery, FTS_CANDIDATE_LIMIT)
      .all<LotRow>();

    for (const row of ftsRows.results ?? []) {
      if (!seen.has(row.lot_id)) {
        seen.add(row.lot_id);
        results.push(row);
      }
    }
  } catch {
    // FTS 쿼리 실패 시 (특수문자 등) 폴백으로
  }

  // 2. LIKE 폴백 (FTS에서 후보가 적으면 보충)
  if (results.length < 3) {
    for (const kw of keywords.slice(0, 3)) {
      if (kw.length < 2) continue;
      const likeRows = await db
        .prepare(
          `SELECT id as lot_id, name, address
           FROM parking_lots
           WHERE name LIKE ?1
           LIMIT ?2`,
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
): Promise<{ matched: number; lotLinks: number }> {
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
  if (sources.length === 0) return { matched: 0, lotLinks: 0 };

  const insertBatch: D1PreparedStatement[] = [];
  const updateBatch: D1PreparedStatement[] = [];
  let matched = 0;
  let lotLinks = 0;

  for (const raw of sources) {
    const title = stripHtml(raw.title);
    const content = stripHtml(raw.content);

    // 1. 키워드 추출 → FTS로 후보 검색
    const keywords = extractSearchKeywords(title, content);
    const candidates = await searchCandidateLots(db, keywords);

    // 2. 후보에 대해서만 정밀 채점
    let hasMatch = false;
    for (const lot of candidates) {
      const score = scoreBlogRelevance(title, content, lot.name, lot.address);
      if (score < RELEVANCE_THRESHOLD) continue;

      insertBatch.push(
        db
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
            title,
            content,
            raw.source_url,
            raw.author,
            raw.published_at,
            score,
            raw.id,
            raw.sentiment_score,
            raw.ai_difficulty_keywords,
            raw.ai_summary,
          ),
      );
      lotLinks++;
      hasMatch = true;
    }

    // 매칭이 있을 때만 matched_at 설정 (재매칭 가능하도록)
    if (hasMatch) {
      matched++;
      updateBatch.push(
        db
          .prepare(
            "UPDATE web_sources_raw SET matched_at = datetime('now') WHERE id = ?1",
          )
          .bind(raw.id),
      );
    }
  }

  const D1_BATCH_LIMIT = 500;
  const allStatements = [...insertBatch, ...updateBatch];
  for (let i = 0; i < allStatements.length; i += D1_BATCH_LIMIT) {
    await db.batch(allStatements.slice(i, i + D1_BATCH_LIMIT));
  }

  return { matched, lotLinks };
}
