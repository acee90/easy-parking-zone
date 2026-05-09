/**
 * #149 파이프라인 스크립트 — rule filter + match (API 키 불필요)
 *
 * AI 판정은 Claude subagent가 처리. 스크립트는 SQL 생성만 담당.
 *
 * Usage:
 *   bun run scripts/run-pipeline-149.ts --remote --stage filter  [--limit N]
 *   bun run scripts/run-pipeline-149.ts --remote --stage match-dump  [--limit N]
 *   bun run scripts/run-pipeline-149.ts --remote --stage match-apply --ai-results FILE
 *   bun run scripts/run-pipeline-149.ts --remote --apply local|remote|both  (이미 emit된 파일 적용)
 *
 * 스테이지:
 *   filter       — rule filter UPDATE SQL emit
 *   match-dump   — 고신뢰 match INSERT SQL + medium 후보 JSON emit
 *   match-apply  — subagent AI 결과 읽어서 match INSERT SQL emit
 *
 * 출력: /tmp/pipeline-149-{timestamp}/
 *   filter-chunk-NN.sql        — rule filter UPDATE
 *   match-direct-chunk-NN.sql  — high-high match INSERT + matched_at UPDATE
 *   medium-candidates.json     — AI 평가용 medium 후보 목록
 *   match-ai-chunk-NN.sql      — AI 통과 INSERT + matched_at UPDATE
 */

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { classifyByRule, type RuleFilterInput } from '../src/server/crawlers/lib/rule-filter'
import { getMatchConfidence, stripHtml } from '../src/server/crawlers/lib/scoring'
import { d1Query, isRemote } from './lib/d1'
import { esc, sqlVal } from './lib/sql-flush'

// ── 인자 파싱 ─────────────────────────────────────────────────────

const args = process.argv.slice(2)

function argVal(flag: string): string | null {
  const i = args.indexOf(flag)
  return i >= 0 ? (args[i + 1] ?? null) : null
}

const STAGE = argVal('--stage') ?? ''
const LIMIT = parseInt(argVal('--limit') ?? '300', 10)
const AI_RESULTS_FILE = argVal('--ai-results')
const APPLY = argVal('--apply') // 'local' | 'remote' | 'both'

if (!isRemote) {
  console.error('⚠️  web_sources_raw는 remote D1 전용입니다. --remote 플래그를 추가하세요.')
  process.exit(1)
}

if (!['filter', 'match-dump', 'match-apply', ''].includes(STAGE)) {
  console.error(`⚠️  알 수 없는 stage: "${STAGE}". filter | match-dump | match-apply 중 선택.`)
  process.exit(1)
}

if (STAGE === 'match-apply' && !AI_RESULTS_FILE) {
  console.error('⚠️  match-apply는 --ai-results FILE 필요.')
  process.exit(1)
}

// ── 상수 ──────────────────────────────────────────────────────────

const FTS_LIMIT = 20
const SQL_CHUNK_SIZE = 300
const DB_NAME = 'parking-db'

const tmpDir = argVal('--out') ?? `/tmp/pipeline-149-${Date.now()}`
mkdirSync(tmpDir, { recursive: true })

let chunkIdx = 0
const emittedFiles: string[] = []

// ── SQL 유틸 ──────────────────────────────────────────────────────

function emitSqlChunk(prefix: string, statements: string[]): void {
  if (statements.length === 0) return
  const name = `${prefix}-chunk-${String(++chunkIdx).padStart(2, '0')}.sql`
  const path = `${tmpDir}/${name}`
  const sql = isRemote ? statements.join('\n') : 'BEGIN;\n' + statements.join('\n') + '\nCOMMIT;'
  writeFileSync(path, sql, 'utf-8')
  emittedFiles.push(path)
  console.log(`  → ${name} (${statements.length} rows)`)
}

// ── 타입 ──────────────────────────────────────────────────────────

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

export interface MediumCandidate {
  raw_id: number
  lot_id: string
  lot_name: string
  lot_address: string
  score: number
  title: string
  full_text: string
}

export interface AiResult {
  raw_id: number
  lot_id: string
  filter_passed: boolean
  removed_by: string | null
  sentiment_score: number
  ai_difficulty_keywords: string[]
}

// ── 키워드 + FTS ───────────────────────────────────────────────────

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

function searchCandidateLots(keywords: string[]): LotRow[] {
  if (keywords.length === 0) return []
  const seen = new Set<string>()
  const results: LotRow[] = []

  const ftsQuery = keywords.map((kw) => `"${kw}" OR ${kw}*`).join(' OR ')
  try {
    const rows = d1Query<LotRow>(
      `SELECT lot_id, name, address FROM parking_lots_fts WHERE parking_lots_fts MATCH '${esc(ftsQuery)}' LIMIT ${FTS_LIMIT}`,
    )
    for (const r of rows) {
      if (!seen.has(r.lot_id)) {
        seen.add(r.lot_id)
        results.push(r)
      }
    }
  } catch {
    /* FTS 실패 시 LIKE 폴백 */
  }

  if (results.length < 3) {
    for (const kw of keywords.slice(0, 3)) {
      if (kw.length < 2) continue
      const rows = d1Query<LotRow>(
        `SELECT id as lot_id, name, address FROM parking_lots WHERE name LIKE '%${esc(kw)}%' LIMIT ${FTS_LIMIT - results.length}`,
      )
      for (const r of rows) {
        if (!seen.has(r.lot_id)) {
          seen.add(r.lot_id)
          results.push(r)
        }
      }
      if (results.length >= FTS_LIMIT) break
    }
  }
  return results
}

// ── INSERT SQL 생성 ───────────────────────────────────────────────

function buildInsertSql(
  raw: RawRow,
  lot: LotRow,
  score: number,
  aiResult: AiResult | null,
): string {
  const sentimentScore = aiResult?.sentiment_score ?? raw.sentiment_score
  const difficultyKw = aiResult?.ai_difficulty_keywords
    ? JSON.stringify(aiResult.ai_difficulty_keywords)
    : raw.ai_difficulty_keywords

  const cols = [
    'parking_lot_id',
    'source',
    'source_id',
    'title',
    'content',
    'source_url',
    'author',
    'published_at',
    'relevance_score',
    'raw_source_id',
    'sentiment_score',
    'ai_difficulty_keywords',
    'ai_summary',
    'full_text',
    'full_text_length',
    'full_text_status',
    'full_text_fetched_at',
  ]
  const vals = [
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
    difficultyKw,
    null, // ai_summary는 ai-summary-generator에서 별도 생성
    raw.full_text,
    raw.full_text ? raw.full_text.length : 0,
    raw.full_text_status ?? 'pending',
    raw.full_text_fetched_at,
  ]
    .map(sqlVal)
    .join(', ')

  return `INSERT OR IGNORE INTO web_sources (${cols.join(', ')}) VALUES (${vals});`
}

// ── Stage 1: Rule Filter ──────────────────────────────────────────

async function runFilterStage() {
  console.log('\n📋 Stage: filter')
  const rows = d1Query<{
    id: number
    title: string
    full_text: string | null
    full_text_status: string | null
  }>(
    `SELECT id, title, full_text, full_text_status
     FROM web_sources_raw
     WHERE ai_filtered_at IS NULL AND full_text_status = 'ok'
     ORDER BY id LIMIT ${LIMIT}`,
  )
  console.log(`  대상: ${rows.length}건`)
  if (rows.length === 0) return { processed: 0, high: 0, medium: 0, low: 0 }

  let high = 0,
    medium = 0,
    low = 0
  const buf: string[] = []

  for (const row of rows) {
    const tier = classifyByRule({
      fullText: row.full_text,
      fullTextStatus: row.full_text_status,
      title: row.title,
    } as RuleFilterInput)
    if (tier === 'low') {
      buf.push(
        `UPDATE web_sources_raw SET filter_passed = 0, filter_removed_by = 'rule_low', filter_tier = 'low', ai_filtered_at = datetime('now') WHERE id = ${row.id};`,
      )
      low++
    } else {
      buf.push(
        `UPDATE web_sources_raw SET filter_passed = 1, filter_tier = '${tier}', ai_filtered_at = datetime('now') WHERE id = ${row.id};`,
      )
      if (tier === 'high') high++
      else medium++
    }
    if (buf.length >= SQL_CHUNK_SIZE) emitSqlChunk('filter', buf.splice(0))
  }
  if (buf.length > 0) emitSqlChunk('filter', buf)

  return { processed: rows.length, high, medium, low }
}

// ── Stage 2a: Match Dump ──────────────────────────────────────────

async function runMatchDumpStage() {
  console.log('\n🔍 Stage: match-dump')
  const rows = d1Query<RawRow>(
    `SELECT id, source, source_id, source_url, title, content, author, published_at,
            sentiment_score, ai_difficulty_keywords,
            full_text, full_text_status, full_text_fetched_at, filter_tier
     FROM web_sources_raw
     WHERE filter_passed = 1 AND matched_at IS NULL
     ORDER BY id LIMIT ${LIMIT}`,
  )
  console.log(`  대상: ${rows.length}건`)
  if (rows.length === 0) return { processed: 0, directLinks: 0, mediumCandidates: 0 }

  let directLinks = 0
  const directInserts: string[] = []
  const directUpdates: string[] = []
  const mediumCandidates: MediumCandidate[] = []
  const immediateMatchedIds = new Set<number>()

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    const title = stripHtml(raw.title)
    const content = stripHtml(raw.content)

    const keywords = extractSearchKeywords(title, content)
    const candidates = searchCandidateLots(keywords)

    const highMatches: Array<{ lot: LotRow; score: number }> = []
    const mediumMatches: Array<{ lot: LotRow; score: number }> = []

    for (const lot of candidates) {
      const { score, confidence } = getMatchConfidence(title, content, lot.name, lot.address)
      if (confidence === 'high') highMatches.push({ lot, score })
      else if (confidence === 'medium') mediumMatches.push({ lot, score })
    }

    const isRuleHigh = raw.filter_tier === 'high'
    let hasDirectInsert = false

    // rule=high & match=high → 직접 INSERT (AI 불필요)
    for (const { lot, score } of highMatches) {
      if (isRuleHigh) {
        directInserts.push(buildInsertSql(raw, lot, score, null))
        directLinks++
        hasDirectInsert = true
      } else {
        mediumMatches.push({ lot, score })
      }
    }

    // medium 후보 → AI 평가용 JSON 저장
    for (const { lot, score } of mediumMatches) {
      mediumCandidates.push({
        raw_id: raw.id,
        lot_id: lot.lot_id,
        lot_name: lot.name,
        lot_address: lot.address,
        score,
        title,
        full_text: (raw.full_text ?? content).slice(0, 6000),
      })
    }

    // matched_at: medium 후보 없는 경우만 즉시 처리
    const attempted = candidates.length > 0 || keywords.length > 0
    if (attempted && mediumMatches.length === 0) {
      directUpdates.push(
        `UPDATE web_sources_raw SET matched_at = datetime('now') WHERE id = ${raw.id};`,
      )
      immediateMatchedIds.add(raw.id)
    }

    if ((i + 1) % 50 === 0 || i === rows.length - 1) {
      process.stdout.write(
        `\r  진행: ${i + 1}/${rows.length}  직접링크: ${directLinks}  medium: ${mediumCandidates.length}  `,
      )
    }

    if (directInserts.length + directUpdates.length >= SQL_CHUNK_SIZE) {
      emitSqlChunk('match-direct', [...directInserts.splice(0), ...directUpdates.splice(0)])
    }
  }

  if (directInserts.length + directUpdates.length > 0) {
    emitSqlChunk('match-direct', [...directInserts, ...directUpdates])
  }
  console.log()

  // medium 후보 JSON emit
  const candidatesFile = `${tmpDir}/medium-candidates.json`
  writeFileSync(
    candidatesFile,
    JSON.stringify(
      { candidates: mediumCandidates, generated_at: new Date().toISOString() },
      null,
      2,
    ),
    'utf-8',
  )
  console.log(`  → medium-candidates.json (${mediumCandidates.length}건)`)

  return {
    processed: rows.length,
    directLinks,
    mediumCandidates: mediumCandidates.length,
    candidatesFile,
  }
}

// ── Stage 2b: Match Apply (AI 결과 반영) ─────────────────────────

async function runMatchApplyStage() {
  console.log('\n✅ Stage: match-apply')

  if (!AI_RESULTS_FILE || !existsSync(AI_RESULTS_FILE)) {
    console.error(`⚠️  AI 결과 파일 없음: ${AI_RESULTS_FILE}`)
    process.exit(1)
  }

  const { results }: { results: AiResult[] } = JSON.parse(readFileSync(AI_RESULTS_FILE, 'utf-8'))
  console.log(`  AI 결과: ${results.length}건`)

  const passingIds = results.filter((r) => r.filter_passed).map((r) => r.raw_id)
  if (passingIds.length === 0) {
    console.log('  통과 항목 없음.')
    return { aiTotal: results.length, aiPassed: 0, removalBreakdown: {} }
  }

  // raw 데이터 재조회 (통과 항목만)
  const idList = [...new Set(passingIds)].join(', ')
  const rawRows = d1Query<RawRow>(
    `SELECT id, source, source_id, source_url, title, content, author, published_at,
            sentiment_score, ai_difficulty_keywords,
            full_text, full_text_status, full_text_fetched_at, filter_tier
     FROM web_sources_raw WHERE id IN (${idList})`,
  )
  const rawById = new Map(rawRows.map((r) => [r.id, r]))

  // medium-candidates.json에서 원래 score 복원
  const scoreMap = new Map<string, number>()
  const candidatesFile = AI_RESULTS_FILE!.replace(/\/[^/]+$/, '') + '/medium-candidates.json'
  if (existsSync(candidatesFile)) {
    const { candidates }: { candidates: MediumCandidate[] } = JSON.parse(
      readFileSync(candidatesFile, 'utf-8'),
    )
    for (const c of candidates) scoreMap.set(`${c.raw_id}:${c.lot_id}`, c.score)
  }

  const inserts: string[] = []
  const updates: string[] = []
  const allRawIds = new Set(results.map((r) => r.raw_id))
  const removalBreakdown: Record<string, number> = {}

  for (const result of results) {
    if (result.filter_passed) {
      const raw = rawById.get(result.raw_id)
      if (raw) {
        const score = scoreMap.get(`${result.raw_id}:${result.lot_id}`) ?? 0
        inserts.push(
          buildInsertSql(raw, { lot_id: result.lot_id, name: '', address: '' }, score, result),
        )
      }
    } else {
      const reason = result.removed_by ?? 'unknown'
      removalBreakdown[reason] = (removalBreakdown[reason] ?? 0) + 1
    }
  }

  // matched_at 업데이트 (모든 AI 평가 대상 raw_id)
  for (const rawId of allRawIds) {
    updates.push(`UPDATE web_sources_raw SET matched_at = datetime('now') WHERE id = ${rawId};`)
  }

  const all = [...inserts, ...updates]
  for (let i = 0; i < all.length; i += SQL_CHUNK_SIZE) {
    emitSqlChunk('match-ai', all.slice(i, i + SQL_CHUNK_SIZE))
  }

  return { aiTotal: results.length, aiPassed: inserts.length, removalBreakdown }
}

// ── Apply SQL Files ───────────────────────────────────────────────

function applySqlFiles(target: 'local' | 'remote', files: string[]): void {
  const flag = target === 'remote' ? '--remote' : '--local'
  console.log(`\n🚀 apply → ${target}`)
  for (const filePath of files) {
    process.stdout.write(`  ${filePath.split('/').pop()} ...`)
    execSync(`bunx wrangler d1 execute ${DB_NAME} ${flag} --file="${filePath}"`, { stdio: 'pipe' })
    console.log(' ✓')
  }
}

// ── Main ──────────────────────────────────────────────────────────

function pct(n: number, total: number) {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '-'
}

async function main() {
  // --apply only (이미 emit된 파일 적용)
  if (!STAGE && APPLY) {
    const dir = argVal('--out') ?? ''
    if (!dir) {
      console.error('⚠️  --out DIR 필요')
      process.exit(1)
    }
    const files = require('node:fs')
      .readdirSync(dir)
      .filter((f: string) => f.endsWith('.sql'))
      .map((f: string) => `${dir}/${f}`)
    if (APPLY === 'local' || APPLY === 'both') applySqlFiles('local', files)
    if (APPLY === 'remote' || APPLY === 'both') applySqlFiles('remote', files)
    return
  }

  console.log('\n🚀 #149 파이프라인')
  console.log(`   stage=${STAGE || '(none)'}  limit=${LIMIT}  apply=${APPLY ?? '없음'}`)
  console.log(`   출력: ${tmpDir}\n`)

  let filterStats: Awaited<ReturnType<typeof runFilterStage>> | null = null
  let dumpStats: Awaited<ReturnType<typeof runMatchDumpStage>> | null = null
  let applyStats: Awaited<ReturnType<typeof runMatchApplyStage>> | null = null

  if (STAGE === 'filter') filterStats = await runFilterStage()
  if (STAGE === 'match-dump') dumpStats = await runMatchDumpStage()
  if (STAGE === 'match-apply') applyStats = await runMatchApplyStage()

  // 리포트
  const sep = '─'.repeat(52)
  console.log(`\n${sep}\n📊 Report`)
  console.log(sep)

  if (filterStats?.processed) {
    const { processed: p, high, medium, low } = filterStats
    console.log(`\n[Rule Filter]  ${p}건`)
    console.log(`  high   ${String(high).padStart(5)}건  (${pct(high, p)})`)
    console.log(`  medium ${String(medium).padStart(5)}건  (${pct(medium, p)})`)
    console.log(`  low    ${String(low).padStart(5)}건  (${pct(low, p)})`)
  }

  if (dumpStats?.processed) {
    const { processed: p, directLinks, mediumCandidates, candidatesFile } = dumpStats
    console.log(`\n[Match Dump]  ${p}건`)
    console.log(`  직접 링크   ${directLinks}건`)
    console.log(`  medium 후보 ${mediumCandidates}건 → ${candidatesFile}`)
    if (mediumCandidates > 0) {
      console.log(`\n  → 다음 단계: /run-pipeline 커맨드에서 haiku subagent로 AI 평가 후`)
      console.log(
        `    bun run scripts/run-pipeline-149.ts --remote --stage match-apply --ai-results {FILE} --out ${tmpDir}`,
      )
    }
  }

  if (applyStats) {
    const { aiTotal, aiPassed, removalBreakdown } = applyStats
    console.log(`\n[Match Apply (AI)]  ${aiTotal}건 평가`)
    console.log(`  통과  ${aiPassed}건  (${pct(aiPassed, aiTotal)})`)
    console.log(`  제거  ${aiTotal - aiPassed}건`)
    for (const [reason, count] of Object.entries(removalBreakdown).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${reason.padEnd(14)} ${count}건`)
    }
  }

  if (emittedFiles.length > 0) {
    console.log(`\n[SQL Files]  ${tmpDir}`)
    for (const f of emittedFiles) console.log(`  ${f.split('/').pop()}`)

    if (APPLY) {
      if (APPLY === 'local' || APPLY === 'both') applySqlFiles('local', emittedFiles)
      if (APPLY === 'remote' || APPLY === 'both') applySqlFiles('remote', emittedFiles)
      console.log('\n✅ 완료')
    } else {
      console.log('\n💡 적용:')
      console.log(`   bun run scripts/run-pipeline-149.ts --remote --apply local  --out ${tmpDir}`)
      console.log(`   bun run scripts/run-pipeline-149.ts --remote --apply remote --out ${tmpDir}`)
    }
  }
  console.log()
}

main().catch((err) => {
  console.error('\n❌ 에러:', err.message)
  process.exit(1)
})
