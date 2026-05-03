/**
 * #148 Phase C — re-evaluate filter + relevance for matched web_sources
 * using full_text body (instead of snippet).
 *
 * Two-phase model (#140 pattern):
 *   1. dump pending rows from remote D1 (single wrangler --command call)
 *   2. compute relevance_score_v2 (local, no AI) + filter_passed_v2 (Haiku batched)
 *   3. emit UPDATE statements to chunked SQL files
 *   4. apply via wrangler --file
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... bun run scripts/refilter-matched.ts \
 *     --remote --source=naver_blog --limit=100 \
 *     --concurrency=4 --batch-size=5 --output-dir=/tmp/refilter-out
 *
 *   # apply afterwards:
 *   for f in /tmp/refilter-out/*.sql; do bunx wrangler d1 execute parking-db --remote --file="$f"; done
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
  args.find((a) => a.startsWith('--output-dir='))?.split('=')[1] ?? '/tmp/refilter-out'
const ROWS_PER_FILE = parseInt(
  args.find((a) => a.startsWith('--rows-per-file='))?.split('=')[1] ?? '500',
  10,
)
const SHARDS = parseInt(args.find((a) => a.startsWith('--shards='))?.split('=')[1] ?? '1', 10)
const SHARD = parseInt(args.find((a) => a.startsWith('--shard='))?.split('=')[1] ?? '0', 10)
const DRY_RUN = args.includes('--dry-run')

if (SHARDS < 1 || SHARD < 0 || SHARD >= SHARDS) {
  console.error(`invalid shard config: --shard=${SHARD} --shards=${SHARDS}`)
  process.exit(1)
}

if (SOURCE_ARG !== 'all' && !SUPPORTED_SOURCES.includes(SOURCE_ARG as SourceType)) {
  console.error(`unsupported --source=${SOURCE_ARG}`)
  process.exit(1)
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY required (set in env or .dev.vars)')
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
): Promise<void> {
  // Local relevance v2 (no AI cost)
  const relevanceMap = new Map<number, number>()
  for (const r of batch) {
    const v2 = scoreBlogRelevanceFull(r.title, r.full_text, r.lot_name, r.lot_address)
    relevanceMap.set(r.id, v2)
  }

  // AI filter v2
  const inputs: FilterV2Input[] = batch.map((r) => ({
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
    counters.ai_error += batch.length
    process.stderr.write(
      `    [ai_error] batch of ${batch.length}: ${err instanceof Error ? err.message : err}\n`,
    )
  }

  for (const row of batch) {
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

async function processSource(source: SourceType): Promise<Counters> {
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
          await processBatch(batch, counters, writer)
          if (counters.total % 25 === 0 || counters.total === rows.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            const rate = (counters.total / parseFloat(elapsed)).toFixed(1)
            process.stdout.write(
              `    ${source} ${counters.total}/${rows.length} (${rate} req/s, passed=${counters.passed} failed=${counters.failed} err=${counters.ai_error})\n`,
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
  console.log(`\n📥 #148 refilter-matched (fetch + emit SQL)`)
  console.log(`   query: ${isRemote ? 'remote' : 'local'} D1`)
  console.log(
    `   source=${SOURCES_TO_PROCESS.join(',')} limit=${LIMIT} concurrency=${CONCURRENCY} batch=${BATCH_SIZE} ${DRY_RUN ? 'DRY-RUN' : 'WRITE-SQL'}`,
  )
  if (SHARDS > 1) console.log(`   shard=${SHARD}/${SHARDS}`)
  if (!DRY_RUN) {
    mkdirSync(OUTPUT_DIR, { recursive: true })
    console.log(`   output_dir=${OUTPUT_DIR} (${ROWS_PER_FILE} rows/file)`)
  }

  const totals = emptyCounters()
  for (const source of SOURCES_TO_PROCESS) {
    const c = await processSource(source)
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

  if (!DRY_RUN) {
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
