/**
 * 주차장 하이브리드 매칭 모듈 (Workers Cron용)
 *
 * filter_passed=1인 web_sources_raw를 FTS5로 후보 검색 후:
 *   - rule=high & match=high: AI 없이 바로 저장
 *   - 그 외 (rule=medium 또는 match=medium): lot_name + full_text로 AI 품질 판정 후 저장
 *   - low/none: 스킵
 */

import {
  buildFilterV2UserPrompt,
  FILTER_V2_SYSTEM_PROMPT,
  type FilterV2Input,
  type FilterV2Output,
} from './lib/ai-filter-v2-prompt'
import { getMatchConfidence, stripHtml } from './lib/scoring'

const MAX_PER_RUN = 50
/** FTS 후보 최대 개수 */
const FTS_CANDIDATE_LIMIT = 20

interface RawRow {
  id: number
  source: string
  source_id: string
  source_url: string
  title: string
  content: string
  author: string | null
  published_at: string | null
  sentiment_score: number | null
  ai_difficulty_keywords: string | null
  ai_summary: string | null
  full_text: string | null
  full_text_status: string | null
  full_text_fetched_at: string | null
  filter_tier: string | null
}

interface LotRow {
  lot_id: string
  name: string
  address: string
}

const STOP_WORDS = new Set([
  '주차장',
  '주차',
  '후기',
  '정보',
  '공유',
  '추천',
  '이용',
  '요금',
  '무료',
  '저렴',
  '가격',
  '시간',
  '위치',
  '근처',
  '주변',
  '최신',
  '리스트',
  '포함',
  '안내',
  '방법',
  '꿀팁',
  '총정리',
  '비교',
  '네이버',
  '블로그',
  '카페',
  '유튜브',
  '플레이스',
  '리뷰',
])

function extractSearchKeywords(title: string, content: string): string[] {
  const text = `${title} ${content}`.slice(0, 500)
  const words = text
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 2 && w.length <= 15)
    .filter((w) => !STOP_WORDS.has(w))
    .filter((w) => !/^\d+$/.test(w))
  return [...new Set(words)].slice(0, 5)
}

async function searchCandidateLots(db: D1Database, keywords: string[]): Promise<LotRow[]> {
  if (keywords.length === 0) return []

  const seen = new Set<string>()
  const results: LotRow[] = []

  // 1. FTS5 검색
  const ftsQuery = keywords.map((kw) => `"${kw}" OR ${kw}*`).join(' OR ')
  try {
    const ftsRows = await db
      .prepare(
        `SELECT lot_id, name, address FROM parking_lots_fts
         WHERE parking_lots_fts MATCH ?1 LIMIT ?2`,
      )
      .bind(ftsQuery, FTS_CANDIDATE_LIMIT)
      .all<LotRow>()

    for (const row of ftsRows.results ?? []) {
      if (!seen.has(row.lot_id)) {
        seen.add(row.lot_id)
        results.push(row)
      }
    }
  } catch {
    /* FTS 쿼리 실패 시 폴백으로 */
  }

  // 2. LIKE 폴백
  if (results.length < 3) {
    for (const kw of keywords.slice(0, 3)) {
      if (kw.length < 2) continue
      const likeRows = await db
        .prepare(
          `SELECT id as lot_id, name, address FROM parking_lots
           WHERE name LIKE ?1 LIMIT ?2`,
        )
        .bind(`%${kw}%`, FTS_CANDIDATE_LIMIT - results.length)
        .all<LotRow>()

      for (const row of likeRows.results ?? []) {
        if (!seen.has(row.lot_id)) {
          seen.add(row.lot_id)
          results.push(row)
        }
      }
      if (results.length >= FTS_CANDIDATE_LIMIT) break
    }
  }

  return results
}

export async function runMatchBatch(
  db: D1Database,
  env?: { ANTHROPIC_API_KEY?: string },
): Promise<{ matched: number; lotLinks: number; aiVerified: number }> {
  const rows = await db
    .prepare(
      `SELECT id, source, source_id, source_url, title, content, author, published_at,
              sentiment_score, ai_difficulty_keywords, ai_summary,
              full_text, full_text_status, full_text_fetched_at, filter_tier
       FROM web_sources_raw
       WHERE filter_passed = 1 AND matched_at IS NULL
       ORDER BY id
       LIMIT ?1`,
    )
    .bind(MAX_PER_RUN)
    .all<RawRow>()

  const sources = rows.results ?? []
  if (sources.length === 0) return { matched: 0, lotLinks: 0, aiVerified: 0 }

  const insertBatch: D1PreparedStatement[] = []
  const updateBatch: D1PreparedStatement[] = []
  let matched = 0
  let lotLinks = 0
  let aiVerified = 0

  for (const raw of sources) {
    const title = stripHtml(raw.title)
    const content = stripHtml(raw.content)
    let thisItemLinked = 0

    // 1. FTS로 후보 검색
    const keywords = extractSearchKeywords(title, content)
    const candidates = await searchCandidateLots(db, keywords)

    // 2. 후보별 신뢰도 판정
    const highMatches: Array<{ lot: LotRow; score: number }> = []
    const mediumMatches: Array<{ lot: LotRow; score: number }> = []

    for (const lot of candidates) {
      const { score, confidence } = getMatchConfidence(title, content, lot.name, lot.address)
      if (confidence === 'high') {
        highMatches.push({ lot, score })
      } else if (confidence === 'medium') {
        mediumMatches.push({ lot, score })
      }
    }

    // 3. rule=high & match=high → AI 없이 바로 저장
    const isRuleHigh = raw.filter_tier === 'high'
    for (const { lot, score } of highMatches) {
      if (isRuleHigh) {
        insertBatch.push(buildInsert(db, raw, lot, score, null))
        lotLinks++
        thisItemLinked++
      } else {
        mediumMatches.push({ lot, score })
      }
    }

    // 4. rule=medium 또는 match=medium → lot_name + full_text로 AI 판정
    if (mediumMatches.length > 0 && env?.ANTHROPIC_API_KEY) {
      const inputs: FilterV2Input[] = mediumMatches.map(({ lot }) => ({
        id: raw.id,
        lot_name: lot.name,
        lot_address: lot.address,
        title,
        full_text: (raw.full_text ?? content).slice(0, 6000),
      }))

      try {
        const results = await callPostMatchFilter(inputs, env.ANTHROPIC_API_KEY)
        for (let j = 0; j < mediumMatches.length; j++) {
          const { lot, score } = mediumMatches[j]
          const aiResult = results[j]
          if (aiResult?.filter_passed) {
            insertBatch.push(buildInsert(db, raw, lot, score, aiResult))
            lotLinks++
            thisItemLinked++
            aiVerified++
          }
        }
      } catch (err) {
        console.log(`[match] AI verify error: ${(err as Error).message}`)
      }
    }

    // matched_at: 매칭 시도 완료 표시 (재처리 방지)
    // 후보가 없거나 임계값 미달이어도 시도 완료로 기록.
    // 새 주차장 추가 등으로 재매칭이 필요하면 matched_at을 NULL로 리셋.
    const attempted = candidates.length > 0 || keywords.length > 0
    if (attempted) {
      if (thisItemLinked > 0) matched++
      updateBatch.push(
        db
          .prepare("UPDATE web_sources_raw SET matched_at = datetime('now') WHERE id = ?1")
          .bind(raw.id),
      )
    }
  }

  const D1_BATCH_LIMIT = 500
  const allStatements = [...insertBatch, ...updateBatch]
  for (let i = 0; i < allStatements.length; i += D1_BATCH_LIMIT) {
    await db.batch(allStatements.slice(i, i + D1_BATCH_LIMIT))
  }

  return { matched, lotLinks, aiVerified }
}

function buildInsert(
  db: D1Database,
  raw: RawRow,
  lot: LotRow,
  score: number,
  aiResult: FilterV2Output | null,
): D1PreparedStatement {
  const sentimentScore = aiResult?.sentiment_score ?? raw.sentiment_score
  const difficultyKeywords = aiResult?.ai_difficulty_keywords
    ? JSON.stringify(aiResult.ai_difficulty_keywords)
    : raw.ai_difficulty_keywords

  // full_text는 web_sources_raw에서만 관리 (raw_source_id JOIN으로 조회).
  // web_sources는 정제된 데이터(요약/sentiment/관계)만 보유.
  return db
    .prepare(
      `INSERT OR IGNORE INTO web_sources
       (parking_lot_id, source, source_id, title, content, source_url,
        author, published_at, relevance_score, raw_source_id,
        sentiment_score, ai_difficulty_keywords, ai_summary)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
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
      sentimentScore,
      difficultyKeywords,
      null, // ai_summary는 post-match ai-summary-generator에서 별도 생성
    )
}

const HAIKU_MODEL = 'claude-haiku-4-5-20251001'
const API_URL = 'https://api.anthropic.com/v1/messages'

async function callPostMatchFilter(
  inputs: FilterV2Input[],
  apiKey: string,
): Promise<FilterV2Output[]> {
  if (inputs.length === 0) return []

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: HAIKU_MODEL,
      max_tokens: 150 * inputs.length,
      system: FILTER_V2_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Process the following ${inputs.length} record(s). Return a JSON array, one element per record in the same order. Include the input id in each element.\n\n${buildFilterV2UserPrompt(inputs)}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    throw new Error(`Haiku API ${res.status}: ${await res.text()}`)
  }

  const data = (await res.json()) as { content: Array<{ type: string; text: string }> }
  const text = data.content[0]?.text ?? ''

  try {
    const jsonText = text
      .replace(/^```(?:json)?\n?/, '')
      .replace(/\n?```$/, '')
      .trim()
    // 단일 객체일 경우 배열로 감싸기
    const parsed = JSON.parse(
      jsonText.startsWith('[') ? jsonText : `[${jsonText}]`,
    ) as FilterV2Output[]

    const byId = new Map(parsed.map((p) => [p.id, p]))
    return inputs.map((input, idx) => {
      const matched = byId.get(input.id) ?? parsed[idx]
      if (matched) return { ...matched, id: input.id }
      return {
        id: input.id,
        filter_passed: false,
        removed_by: 'ai_error',
        sentiment_score: 3.0,
        ai_difficulty_keywords: [],
      }
    })
  } catch {
    return inputs.map((input) => ({
      id: input.id,
      filter_passed: false,
      removed_by: 'ai_error',
      sentiment_score: 3.0,
      ai_difficulty_keywords: [],
    }))
  }
}
