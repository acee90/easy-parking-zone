/**
 * 크롤링 파이프라인 공식 필터 단계 — full_text 기반 3-tier filter.
 *
 *   high  (score≥75 & len≥2000): auto-pass, no AI
 *   none  (score<25 | score=0 | ad pattern): auto-fail, no AI
 *   medium: AI filter (Haiku)
 *
 * Usage:
 *   # 1차: 스크립트 분류만 (API key 불필요)
 *   bun run scripts/filter-web-sources.ts \
 *     --remote --source=all --limit=2000 --classify-only \
 *     --output-dir=data/filter-out
 *
 *   # 2차: 전체 실행 (medium → Haiku AI)
 *   ANTHROPIC_API_KEY=sk-... bun run scripts/filter-web-sources.ts \
 *     --remote --source=all --limit=2000 \
 *     --concurrency=4 --batch-size=5 --output-dir=data/filter-out
 *
 *   # apply:
 *   for f in data/filter-out/*.sql; do bunx wrangler d1 execute parking-db --remote --file="$f"; done
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import {
  buildFilterV2UserPrompt,
  FILTER_V2_SYSTEM_PROMPT,
  type FilterV2Input,
  type FilterV2Output,
} from '../src/server/crawlers/lib/ai-filter-v2-prompt'
import { scoreBlogRelevanceFull } from '../src/server/crawlers/lib/scoring'
import { d1Query, isRemote } from './lib/d1'
import { esc } from './lib/sql-flush'

// --- Tier thresholds ---
// none: too weak a signal for AI to be useful → auto-fail
const LOW_SCORE_THRESHOLD = 35
// below this length the post is too short to evaluate reliably → auto-fail
const MIN_FULLTEXT_FOR_MEDIUM = 500

// High-tier semantic thresholds (calibrated on wave ground-truth, precision=57%)
// lot name must appear at least this many times (anti-wrong_lot)
const HIGH_LOT_MIN_MENTIONS = 2
// narrative verbs must match at least this many times (anti-thin/boilerplate)
const HIGH_NARRATIVE_MIN_MATCHES = 2

// Ad/sponsorship patterns — checked BEFORE any auto-pass so no ad can slip into high tier.
// Covers both hashtag disclosures (#광고) and sentence-level disclosures.
const FULLTEXT_AD_PATTERNS = [
  // 협찬
  /#협찬/,
  /협찬\s*(?:을\s*)?받[았아]/,
  /협찬\s*받은/,
  /협찬\s*(?:제품|품)/,
  /제품\s*협찬/,
  // 광고 고지 — 해시태그
  /#광고/,
  /#유료광고/,
  // 광고 고지 — 문장
  /유료\s*광고/,
  /홍보\s*포스팅입니다/,
  /광고\s*포스팅입니다/,
  /이\s*포스팅은\s*광고/,
  /이\s*(?:게시물|글)은?\s*광고/,
  /본\s*(?:포스팅|게시물|글)은?\s*(?:유료\s*)?광고/,
  /광고비\s*를?\s*받[아았]/,
  // 서포터즈 / 체험단
  /서포터즈\s*(?:활동|후기|선정)/,
  /체험단\s*(?:선정|후기|글|이벤트)/,
  // 원고료 — 받아 + 받았 + 받고 모두 포함
  /원고료\s*를?\s*받[아았고]/,
]

// Semantic patterns for high-tier auto-pass (backed by wave eval ground truth)
// Personal experience narrative verbs — 1인칭 과거 서술 (anti-thin / anti-boilerplate)
const FULLTEXT_NARRATIVE_RE =
  /했어요|했습니다|이었어요|더라고요|더라구요|가봤|이용했|주차했|방문했|다녀왔|다녀와서|들어갔|나왔|기다렸|찾았|돌았|빙빙|힘들었|어려웠|불편했|편했|좋았|나빴/g

// Concrete parking experience — actual difficulty/ease/fee/time descriptions (anti-boilerplate)
const FULLTEXT_CONCRETE_PARKING_RE =
  /주차하기\s*(?:어렵|힘들|불편|쉽|편리|좋)|주차가\s*(?:어렵|힘들|불편|쉽|편리|좋|안됨)|주차난|만차|자리가\s*(?:없|부족|꽉)|빈\s*자리|빈자리|진입(?:로)?(?:이|가)?\s*(?:좁|어렵|힘들|복잡|막|불편)|주차\s*(?:비|요금|료)\s*(?:\d|유료|무료|비싸|저렴|싸|부담)|(?:\d+분|\d+시간)\s*(?:주차|대기|기다)|주차\s*(?:꿀팁|팁|후기|리뷰)|출차\s*(?:했|어렵|힘들|오래)|주차면|주차공간이?\s*(?:좁|협소|넓|충분|부족)/

// Boilerplate signals — SEO templates, structured info pages, store directory pages
// Used in: (a) high-tier exclusion, (b) none-tier auto-fail (precision 94.8%, FN 4.8%)
const FULLTEXT_BOILERPLATE_RE =
  /주차정보\s*(?:휴무일|층별|안내)|운영시간\s*및\s*(?:요금|주차)|층별\s*안내|(?:기본\s*)?(?:시간\/요금|시간당 요금)|주차구획수:|운영요일:|관리기관명:|Top\s*\d+\s*(?:주차|저렴)|주변\s*주차장\s*(?:순위|Top|추천|목록)/

// News/official announcement signals — press releases, municipal notices (precision 98.4%, FN 0.6%)
const FULLTEXT_NEWS_RE =
  /민원\s*증가|조성.*추진|운영하기로|추진한다|지자체\s*(?:는|은|가|이)\s*(?:발표|결정|추진)|보도자료|구청장|시의회|예산/

// Score below which a zero-lot-mention post is almost certainly wrong_lot (precision 96.5%, FN 1.1%)
const WRONG_LOT_MAX_SCORE = 60

/** Extract a matchable core name by stripping lot-type suffixes */
function extractLotCore(lotName: string): string {
  return lotName.replace(/\s*(?:공영|민영|노외|노상|부설|임시|제\d+)?\s*주차장\s*$/, '').trim()
}

/** Count occurrences of lot name in full text (uses core name if ≥3 chars) */
function countLotMentions(lotName: string, fullText: string): number {
  const core = extractLotCore(lotName)
  const needle = core.length >= 3 ? core : lotName
  if (!needle) return 0
  let count = 0
  let pos = 0
  while ((pos = fullText.indexOf(needle, pos)) !== -1) {
    count++
    pos += needle.length
  }
  return count
}

type Tier = 'high' | 'medium' | 'none'

/**
 * 3-tier classifier.
 *
 * High tier criteria (wave ground-truth calibrated, precision≈57% vs old score-based 16%):
 *   • lot name appears ≥2 times  → anti-wrong_lot
 *   • narrative verbs ≥2 matches → anti-thin / anti-boilerplate
 *   • concrete parking expression → confirms real parking content
 *   • NOT a boilerplate template  → anti-SEO-page
 */
function classifyTier(
  relevanceScore: number,
  fullText: string,
  lotName: string,
): { tier: Tier; reason?: string } {
  // 1. Ad check always runs first — no ad can slip into high tier
  if (FULLTEXT_AD_PATTERNS.some((p) => p.test(fullText))) return { tier: 'none', reason: 'ad' }
  if (relevanceScore === 0) return { tier: 'none', reason: 'irrelevant' }
  if (relevanceScore < LOW_SCORE_THRESHOLD) return { tier: 'none', reason: 'low_relevance' }
  // 2. Too short → auto-fail before any further checks
  if (fullText.length < MIN_FULLTEXT_FOR_MEDIUM) return { tier: 'none', reason: 'too_short' }
  // 3. Content-type auto-fails: catches AI failure modes before hitting medium
  if (FULLTEXT_BOILERPLATE_RE.test(fullText)) return { tier: 'none', reason: 'boilerplate' }
  if (FULLTEXT_NEWS_RE.test(fullText)) return { tier: 'none', reason: 'news' }
  const lotMentions = countLotMentions(lotName, fullText)
  if (lotMentions === 0 && relevanceScore < WRONG_LOT_MAX_SCORE)
    return { tier: 'none', reason: 'wrong_lot' }
  // 4. Thin content: no narrative verbs → almost certainly thin/boilerplate/wrong-lot
  //    (wave calibrated: lot≤1&narr==0 precision=96.3% FN=4%, narr==0&score<80 precision=93.5% FN=3%)
  const narrativeMatches = (fullText.match(FULLTEXT_NARRATIVE_RE) ?? []).length
  if (narrativeMatches === 0 && lotMentions <= 1) return { tier: 'none', reason: 'thin' }
  if (narrativeMatches === 0 && relevanceScore < 80) return { tier: 'none', reason: 'thin' }
  // Single narrative verb with zero lot mentions → too weak to be a real review (prec=95.7%, FN=2.8%)
  if (narrativeMatches <= 1 && lotMentions === 0) return { tier: 'none', reason: 'thin' }
  // 5. High tier: semantic auto-pass (all four conditions must hold)
  if (
    lotMentions >= HIGH_LOT_MIN_MENTIONS &&
    narrativeMatches >= HIGH_NARRATIVE_MIN_MATCHES &&
    FULLTEXT_CONCRETE_PARKING_RE.test(fullText)
  ) {
    return { tier: 'high' }
  }
  return { tier: 'medium' }
}

type SourceType = 'naver_blog' | 'ddg_search'
const SUPPORTED_SOURCES: SourceType[] = ['naver_blog', 'ddg_search']

const args = process.argv.slice(2)
const SOURCE_ARG = args.find((a) => a.startsWith('--source='))?.split('=')[1] ?? 'all'
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '100', 10)
const CONCURRENCY = parseInt(
  args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? '4',
  10,
)
const BATCH_SIZE = parseInt(
  args.find((a) => a.startsWith('--batch-size='))?.split('=')[1] ?? '5',
  10,
)
const OUTPUT_DIR =
  args.find((a) => a.startsWith('--output-dir='))?.split('=')[1] ?? 'data/filter-out'
const ROWS_PER_FILE = parseInt(
  args.find((a) => a.startsWith('--rows-per-file='))?.split('=')[1] ?? '500',
  10,
)
const SHARDS = parseInt(args.find((a) => a.startsWith('--shards='))?.split('=')[1] ?? '1', 10)
const SHARD = parseInt(args.find((a) => a.startsWith('--shard='))?.split('=')[1] ?? '0', 10)
const DRY_RUN = args.includes('--dry-run')
// classify-only: tier 분류 + 통계만, AI 호출 없음 (API key 불필요)
const CLASSIFY_ONLY = args.includes('--classify-only')

if (SHARDS < 1 || SHARD < 0 || SHARD >= SHARDS) {
  console.error(`invalid shard config: --shard=${SHARD} --shards=${SHARDS}`)
  process.exit(1)
}

if (SOURCE_ARG !== 'all' && !SUPPORTED_SOURCES.includes(SOURCE_ARG as SourceType)) {
  console.error(`unsupported --source=${SOURCE_ARG}`)
  process.exit(1)
}

if (!CLASSIFY_ONLY && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY required (or use --classify-only for tier stats without AI)')
  process.exit(1)
}

const SOURCES_TO_PROCESS: SourceType[] =
  SOURCE_ARG === 'all' ? SUPPORTED_SOURCES : [SOURCE_ARG as SourceType]

const FULL_TEXT_CAP = 6000 // tokens budget per record in batch

interface PendingRow {
  id: number
  source: string
  parking_lot_id: string
  title: string
  full_text: string
  lot_name: string
  lot_address: string
}

function fetchPendingRows(source: SourceType, limit: number): PendingRow[] {
  const shardClause = SHARDS > 1 ? `AND ws.id % ${SHARDS} = ${SHARD}` : ''
  return d1Query<PendingRow>(`
    SELECT ws.id, ws.source, ws.parking_lot_id, ws.title, ws.full_text,
      pl.name AS lot_name, pl.address AS lot_address
    FROM web_sources ws
    JOIN parking_lots pl ON pl.id = ws.parking_lot_id
    WHERE ws.source = '${esc(source)}'
      AND ws.full_text_status = 'ok'
      AND LENGTH(ws.full_text) >= 200
      AND ws.filter_passed_v2 IS NULL
      ${shardClause}
    ORDER BY ws.id
    LIMIT ${limit}
  `)
}

function buildUpdate(
  row: PendingRow,
  relevanceV2: number,
  filterOut: FilterV2Output | null,
): string {
  const filterPassed = filterOut ? (filterOut.filter_passed ? 1 : 0) : 0
  const reason = filterOut?.removed_by ?? (filterOut === null ? 'ai_error' : null)
  const reasonClause = reason ? `'${esc(reason)}'` : 'NULL'
  return `UPDATE web_sources SET relevance_score_v2 = ${relevanceV2}, filter_passed_v2 = ${filterPassed}, filter_v2_reason = ${reasonClause}, filter_v2_evaluated_at = datetime('now') WHERE id = ${row.id};`
}

interface ChunkWriter {
  push: (line: string) => void
  flush: () => void
}

function makeChunkWriter(source: SourceType): ChunkWriter {
  let buf: string[] = []
  let chunkIndex = 0
  return {
    push: (line: string): void => {
      buf.push(line)
      if (buf.length >= ROWS_PER_FILE) {
        const shardSuffix = SHARDS > 1 ? `-s${SHARD}` : ''
        const path = join(
          OUTPUT_DIR,
          `${source}${shardSuffix}-${String(chunkIndex).padStart(4, '0')}.sql`,
        )
        writeFileSync(path, buf.join('\n'), 'utf-8')
        console.log(`    wrote ${path} (${buf.length} rows)`)
        chunkIndex++
        buf = []
      }
    },
    flush: (): void => {
      if (buf.length === 0) return
      const shardSuffix = SHARDS > 1 ? `-s${SHARD}` : ''
      const path = join(
        OUTPUT_DIR,
        `${source}${shardSuffix}-${String(chunkIndex).padStart(4, '0')}.sql`,
      )
      writeFileSync(path, buf.join('\n'), 'utf-8')
      console.log(`    wrote ${path} (${buf.length} rows, final)`)
      buf = []
    },
  }
}

interface Counters {
  total: number
  passed: number
  failed: number
  ai_error: number
  reason_breakdown: Record<string, number>
}

function emptyCounters(): Counters {
  return { total: 0, passed: 0, failed: 0, ai_error: 0, reason_breakdown: {} }
}

const client = new Anthropic()

async function callFilterV2(inputs: FilterV2Input[]): Promise<FilterV2Output[]> {
  const userPrompt = buildFilterV2UserPrompt(inputs)
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 600 * inputs.length,
    system: [
      {
        type: 'text',
        text: FILTER_V2_SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Process the following ${inputs.length} record(s). Return a JSON array, one element per record in the same order, matching the schema described in the system prompt. Include the input id in each element.\n\n${userPrompt}`,
      },
    ],
  })

  const text = resp.content
    .filter((c): c is Anthropic.TextBlock => c.type === 'text')
    .map((c) => c.text)
    .join('')
  const jsonText = text
    .replace(/^```(?:json)?\n?/, '')
    .replace(/\n?```$/, '')
    .trim()
  const parsed = JSON.parse(jsonText) as FilterV2Output[]

  // align by id; if model omitted ids, fall back to positional order
  const byId = new Map<number, FilterV2Output>()
  for (const p of parsed) byId.set(p.id, p)
  return inputs.map((input, idx) => {
    const matched = byId.get(input.id)
    if (matched) return matched
    const positional = parsed[idx]
    if (positional) return { ...positional, id: input.id }
    return {
      id: input.id,
      filter_passed: false,
      removed_by: 'ai_error',
      sentiment_score: 3.0,
      ai_difficulty_keywords: [],
    }
  })
}

async function processBatch(
  batch: PendingRow[],
  counters: Counters,
  writer: ChunkWriter,
  mediumCollector?: PendingRow[],
): Promise<void> {
  // 1. Local relevance v2 (no AI cost)
  const relevanceMap = new Map<number, number>()
  for (const r of batch) {
    const v2 = scoreBlogRelevanceFull(r.title, r.full_text, r.lot_name, r.lot_address)
    relevanceMap.set(r.id, v2)
  }

  // 2. Tier classification — high/none handled without AI
  const mediumRows: PendingRow[] = []
  for (const row of batch) {
    const v2 = relevanceMap.get(row.id) ?? 0
    const { tier, reason } = classifyTier(v2, row.full_text, row.lot_name)

    if (tier === 'high') {
      counters.total++
      counters.passed++
      counters.reason_breakdown['auto_high'] = (counters.reason_breakdown['auto_high'] ?? 0) + 1
      if (!DRY_RUN) {
        writer.push(
          buildUpdate(row, v2, {
            id: row.id,
            filter_passed: true,
            removed_by: null,
            sentiment_score: 3.0,
            ai_difficulty_keywords: [],
          }),
        )
      }
    } else if (tier === 'none') {
      counters.total++
      counters.failed++
      const r = reason ?? 'low_relevance'
      counters.reason_breakdown[r] = (counters.reason_breakdown[r] ?? 0) + 1
      if (!DRY_RUN) {
        writer.push(
          buildUpdate(row, v2, {
            id: row.id,
            filter_passed: false,
            removed_by: r,
            sentiment_score: 3.0,
            ai_difficulty_keywords: [],
          }),
        )
      }
    } else {
      mediumRows.push(row)
    }
  }

  if (mediumRows.length === 0) return

  // classify-only: medium 카운트 + collector에 저장, AI 호출 없음
  if (CLASSIFY_ONLY) {
    for (const row of mediumRows) {
      counters.total++
      counters.reason_breakdown['medium'] = (counters.reason_breakdown['medium'] ?? 0) + 1
      mediumCollector?.push(row)
    }
    return
  }

  // 3. AI filter for medium tier only
  const inputs: FilterV2Input[] = mediumRows.map((r) => ({
    id: r.id,
    lot_name: r.lot_name,
    lot_address: r.lot_address,
    title: r.title,
    full_text: r.full_text.slice(0, FULL_TEXT_CAP),
  }))

  let outputs: FilterV2Output[] | null = null
  try {
    outputs = await callFilterV2(inputs)
  } catch (err) {
    counters.ai_error += mediumRows.length
    process.stderr.write(
      `    [ai_error] batch of ${mediumRows.length}: ${err instanceof Error ? err.message : err}\n`,
    )
  }

  for (const row of mediumRows) {
    counters.total++
    const v2 = relevanceMap.get(row.id) ?? 0
    const out = outputs?.find((o) => o.id === row.id) ?? null
    if (out) {
      if (out.filter_passed) counters.passed++
      else counters.failed++
      const reason = out.removed_by ?? 'passed'
      counters.reason_breakdown[reason] = (counters.reason_breakdown[reason] ?? 0) + 1
    }
    if (!DRY_RUN) writer.push(buildUpdate(row, v2, out))
  }
}

async function processSource(
  source: SourceType,
  mediumCollector?: PendingRow[],
): Promise<Counters> {
  const counters = emptyCounters()
  const rows = fetchPendingRows(source, LIMIT)
  console.log(`\n  ${source}: ${rows.length} rows queued`)
  if (rows.length === 0) return counters

  const writer = makeChunkWriter(source)
  const startTime = Date.now()

  // Build batches
  const batches: PendingRow[][] = []
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    batches.push(rows.slice(i, i + BATCH_SIZE))
  }

  // concurrent dispatcher
  await new Promise<void>((resolveAll) => {
    const queue = [...batches]
    let active = 0
    const launch = (): void => {
      while (active < CONCURRENCY && queue.length > 0) {
        const batch = queue.shift()
        if (!batch) break
        active++
        ;(async () => {
          await processBatch(batch, counters, writer, mediumCollector)
          if (counters.total % 25 === 0 || counters.total === rows.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            const rate = (counters.total / parseFloat(elapsed)).toFixed(1)
            const autoHigh = counters.reason_breakdown['auto_high'] ?? 0
            process.stdout.write(
              `    ${source} ${counters.total}/${rows.length} (${rate}/s, passed=${counters.passed} auto_high=${autoHigh} failed=${counters.failed} ai_err=${counters.ai_error})\n`,
            )
          }
          active--
          if (queue.length === 0 && active === 0) resolveAll()
          else launch()
        })()
      }
    }
    launch()
  })

  if (!DRY_RUN) writer.flush()
  return counters
}

function logCounters(label: string, c: Counters): void {
  const passPct = c.total > 0 ? ((c.passed / c.total) * 100).toFixed(1) : '0.0'
  console.log(
    `  [${label}] total=${c.total} passed=${c.passed} (${passPct}%) failed=${c.failed} ai_error=${c.ai_error}`,
  )
  for (const [reason, count] of Object.entries(c.reason_breakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${reason}: ${count}`)
  }
}

async function main(): Promise<void> {
  const mode = CLASSIFY_ONLY ? 'CLASSIFY-ONLY' : DRY_RUN ? 'DRY-RUN' : 'WRITE-SQL'
  console.log(`\n📥 filter-web-sources (3-tier filter + emit SQL)`)
  console.log(`   query: ${isRemote ? 'remote' : 'local'} D1`)
  console.log(
    `   source=${SOURCES_TO_PROCESS.join(',')} limit=${LIMIT} concurrency=${CONCURRENCY} batch=${BATCH_SIZE} ${mode}`,
  )
  if (SHARDS > 1) console.log(`   shard=${SHARD}/${SHARDS}`)
  mkdirSync(OUTPUT_DIR, { recursive: true })
  if (!DRY_RUN || CLASSIFY_ONLY) {
    console.log(`   output_dir=${OUTPUT_DIR} (${ROWS_PER_FILE} rows/file)`)
  }

  const totals = emptyCounters()
  const allMedium: PendingRow[] = []

  for (const source of SOURCES_TO_PROCESS) {
    const c = await processSource(source, CLASSIFY_ONLY ? allMedium : undefined)
    logCounters(source, c)
    totals.total += c.total
    totals.passed += c.passed
    totals.failed += c.failed
    totals.ai_error += c.ai_error
    for (const [k, v] of Object.entries(c.reason_breakdown)) {
      totals.reason_breakdown[k] = (totals.reason_breakdown[k] ?? 0) + v
    }
  }

  console.log()
  logCounters('TOTAL', totals)

  if (CLASSIFY_ONLY && allMedium.length > 0) {
    const mediumPath = join(OUTPUT_DIR, 'medium.json')
    const mediumRecords = allMedium.map((r) => ({
      id: r.id,
      lot_name: r.lot_name,
      lot_address: r.lot_address,
      title: r.title,
      full_text: r.full_text.slice(0, FULL_TEXT_CAP),
    }))
    writeFileSync(mediumPath, JSON.stringify(mediumRecords, null, 2), 'utf-8')
    console.log(`\n  medium.json: ${mediumPath} (${allMedium.length} records)`)
  }

  if (!DRY_RUN && !CLASSIFY_ONLY) {
    console.log(`\n  apply with:`)
    console.log(
      `    for f in ${OUTPUT_DIR}/*.sql; do bunx wrangler d1 execute parking-db --remote --file="$f"; done`,
    )
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
