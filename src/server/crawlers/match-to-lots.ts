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

/**
 * LIKE 폴백용 lot 캐시 — 배치 1회만 로드한다.
 *
 * 과거에는 폴백마다 `parking_lots WHERE name LIKE '%kw%'` 를 날렸는데, 선행 와일드카드라
 * 인덱스를 못 타고 31,994행 풀스캔이 된다(EXPLAIN: SCAN parking_lots). raw 50행 x 키워드
 * 3개면 회당 4.8M행, 하루 48회면 **230M행**으로 D1 rows_read 의 최대 소비처였다.
 * parking_lots 는 3만 행짜리 거의 변하지 않는 테이블이므로 한 번 읽어 메모리에서 거른다.
 * (회당 4.8M → 32k, 약 150배 감소)
 */
let lotCache: Array<LotRow & { nameLower: string }> | null = null

async function getLotCache(db: D1Database): Promise<Array<LotRow & { nameLower: string }>> {
  if (lotCache) return lotCache
  const rows = await db
    .prepare(`SELECT id AS lot_id, name, address FROM parking_lots`)
    .all<LotRow>()
  // SQLite LIKE 는 ASCII 대소문자를 구분하지 않는다 — includes 로 바꾸면서 동작을 맞춘다.
  lotCache = (rows.results ?? []).map((r) => ({ ...r, nameLower: r.name.toLowerCase() }))
  return lotCache
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

  // 2. LIKE 폴백 — DB 쿼리 대신 메모리 캐시에서 거른다 (위 getLotCache 주석 참조)
  if (results.length < 3) {
    const lots = await getLotCache(db)
    for (const kw of keywords.slice(0, 3)) {
      if (kw.length < 2) continue
      const kwLower = kw.toLowerCase()
      let taken = 0
      const budget = FTS_CANDIDATE_LIMIT - results.length
      for (const row of lots) {
        if (taken >= budget) break
        if (!row.nameLower.includes(kwLower)) continue
        taken++
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
  env?: { UNSLOTH_API_KEY?: string; AI_MODEL?: string; AI_BASE_URL?: string },
): Promise<{ matched: number; lotLinks: number; aiVerified: number }> {
  // 배치마다 lot 캐시를 비운다 — isolate 재사용 시 신규 주차장이 누락되지 않도록.
  // (배치 1회당 최대 1번 로드이므로 쿼리 절감 효과는 그대로다.)
  lotCache = null

  const rows = await db
    .prepare(
      // 본문은 web_sources_raw_body에 분리 저장 (0048) — JOIN으로 조회한다.
      `SELECT r.id, r.source, r.source_id, r.source_url, r.title, r.content, r.author, r.published_at,
              r.sentiment_score, r.ai_difficulty_keywords, r.ai_summary,
              b.body AS full_text, r.full_text_status, r.full_text_fetched_at, r.filter_tier
       FROM web_sources_raw r
       LEFT JOIN web_sources_raw_body b ON b.raw_id = r.id
       WHERE r.filter_passed = 1 AND r.matched_at IS NULL
       ORDER BY r.id
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
    if (mediumMatches.length > 0 && env?.UNSLOTH_API_KEY) {
      const inputs: FilterV2Input[] = mediumMatches.map(({ lot }) => ({
        id: raw.id,
        lot_name: lot.name,
        lot_address: lot.address,
        title,
        full_text: (raw.full_text ?? content).slice(0, 6000),
      }))

      try {
        const results = await callPostMatchFilter(
          inputs,
          env.UNSLOTH_API_KEY,
          env.AI_MODEL || undefined,
          env.AI_BASE_URL || undefined,
        )
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
      // matched_at은 web_sources가 자기완결적으로 갖는다 (0049) — 스코어링 재계산이
      // raw를 JOIN하지 않도록. raw는 처리 완료 후 삭제되는 임시 데이터다.
      `INSERT OR IGNORE INTO web_sources
       (parking_lot_id, source, source_id, title, content, source_url,
        author, published_at, relevance_score, raw_source_id,
        sentiment_score, ai_difficulty_keywords, ai_summary, matched_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, datetime('now'))`,
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

/**
 * 셀프호스팅 Unsloth(llama.cpp) OpenAI 호환 엔드포인트.
 *
 * Anthropic 에서 전환한 이유: 운영 ANTHROPIC_API_KEY 가 만료되어 이 단계가 통째로
 * 실패하고 있었다(로그에 401 authentication_error 반복, 에러를 삼켜 드러나지 않음).
 *
 * 서버 특성 (2026-08-19 실측, system_fingerprint b1-dd9280a):
 *  - `response_format: json_object` 를 **받아들이지만 강제하지는 않는다** — 응답이
 *    ```json 펜스로 감싸여 온다. 파싱 전 펜스 제거 필수.
 *  - reasoning 모델이라 json 모드에선 추론이 `reasoning_content` 로 분리되지만,
 *    모드가 없으면 `<think>…</think>` 가 본문에 섞인다. 양쪽 모두 방어한다.
 */
const DEFAULT_AI_MODEL = 'unsloth/gemma-4-E4B-it-GGUF'
const DEFAULT_AI_BASE_URL = 'https://unsloth.arttoken.biz/v1'

async function callPostMatchFilter(
  inputs: FilterV2Input[],
  apiKey: string,
  model = DEFAULT_AI_MODEL,
  baseUrl = DEFAULT_AI_BASE_URL,
): Promise<FilterV2Output[]> {
  if (inputs.length === 0) return []

  // JSON 모드는 최상위가 객체여야 하므로 {"results":[...]} 로 감싸 받는다.
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      // reasoning 모델이라 답을 내기 전에 사고 토큰을 먼저 쓴다. 실측(1건 기준)
      // reasoning 약 500토큰 + 본문 약 50토큰이고, reasoning 은 건수와 거의 무관한
      // 상수항이다. 부족하면 finish_reason='length' 로 잘려 content 가 **빈 문자열**이
      // 되므로(에러가 아니라 조용한 실패) 상수항을 넉넉히 잡는다.
      max_tokens: 1200 + 200 * inputs.length,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: FILTER_V2_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Process the following ${inputs.length} record(s). Respond with a JSON object of the form {"results": [...]} containing one element per record in the same order. Include the input id in each element.\n\n${buildFilterV2UserPrompt(inputs)}`,
        },
      ],
    }),
    signal: AbortSignal.timeout(120_000), // 셀프호스팅 소형모델이라 응답이 느리다
  })

  if (!res.ok) {
    throw new Error(`AI API ${res.status}: ${await res.text()}`)
  }

  const data = (await res.json()) as {
    choices: Array<{ message: { content: string } }>
  }
  const text = data.choices[0]?.message?.content ?? ''

  try {
    const jsonText = text
      .replace(/<think>[\s\S]*?<\/think>/g, '') // reasoning 인라인 출력 제거
      .replace(/^[\s\S]*?```(?:json)?\n?/, '') // 앞쪽 잡담 + 펜스 시작 제거
      .replace(/```[\s\S]*$/, '') // 펜스 종료 이후 제거
      .trim()
    // {"results":[...]} / 배열 / 단일 객체 모두 허용
    const raw = JSON.parse(jsonText.startsWith('[') ? `{"results":${jsonText}}` : jsonText) as
      | { results?: FilterV2Output[] }
      | FilterV2Output
    const parsed: FilterV2Output[] = Array.isArray((raw as { results?: FilterV2Output[] }).results)
      ? ((raw as { results: FilterV2Output[] }).results ?? [])
      : [raw as FilterV2Output]

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
