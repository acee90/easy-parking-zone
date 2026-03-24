/**
 * 주차장 매칭 모듈 (Workers Cron용)
 *
 * filter_passed=1이면서 미매칭인 web_sources_raw를
 * scoreBlogRelevance로 주차장에 매칭하여 web_sources에 INSERT.
 */
import { scoreBlogRelevance, stripHtml, hashUrl } from "./lib/scoring";

const MAX_PER_RUN = 50;
const RELEVANCE_THRESHOLD = 60;

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
  id: string;
  name: string;
  address: string;
}

export async function runMatchBatch(
  db: D1Database,
): Promise<{ matched: number; lotLinks: number }> {
  // filter_passed=1 & 미매칭
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

  // 전체 주차장 목록 (매칭 대상)
  const lotRows = await db
    .prepare("SELECT id, name, address FROM parking_lots")
    .all<LotRow>();
  const lots = lotRows.results ?? [];

  const insertBatch: D1PreparedStatement[] = [];
  const updateBatch: D1PreparedStatement[] = [];
  let lotLinks = 0;

  for (const raw of sources) {
    const title = stripHtml(raw.title);
    const content = stripHtml(raw.content);

    // 모든 주차장에 대해 매칭 점수 계산, threshold 이상만 저장
    for (const lot of lots) {
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
            lot.id,
            raw.source,
            `${raw.source_id}:${lot.id}`, // parking_lot_id별 고유 source_id
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
    }

    // matched_at 업데이트
    updateBatch.push(
      db
        .prepare("UPDATE web_sources_raw SET matched_at = datetime('now') WHERE id = ?1")
        .bind(raw.id),
    );
  }

  // D1 배치 실행
  const D1_BATCH_LIMIT = 500;
  const allStatements = [...insertBatch, ...updateBatch];
  for (let i = 0; i < allStatements.length; i += D1_BATCH_LIMIT) {
    await db.batch(allStatements.slice(i, i + D1_BATCH_LIMIT));
  }

  return { matched: sources.length, lotLinks };
}
