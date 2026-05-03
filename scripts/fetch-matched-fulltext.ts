/**
 * #140 Phase B-2 — populate web_sources.full_text for matched rows.
 *
 * Two-phase model:
 *   1. dump pending rows from remote D1 (single wrangler --command call)
 *   2. fetch each URL via the #139 fetcher library (in-memory, no DB writes during fetch)
 *   3. emit UPDATE statements to chunked SQL files in --output-dir
 *   4. (separate step) apply chunked SQL files to remote with wrangler --file
 *
 * The bottleneck of the previous version was per-batch wrangler subprocess
 * overhead. Splitting the fetch and apply phases lets us crank concurrency up
 * and finish in a fraction of the time.
 *
 * Usage:
 *   # full pipeline (fetch + emit SQL, no DB writes):
 *   bun run scripts/fetch-matched-fulltext.ts --remote --source=naver_blog \
 *     --limit=10000 --concurrency=4 --sleep=300 --output-dir=/tmp/fetch-out
 *
 *   # apply afterwards:
 *   for f in /tmp/fetch-out/*.sql; do bunx wrangler d1 execute parking-db --remote --file="$f"; done
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type FetchResult,
  fetchFullText,
  type SourceType,
} from '../src/server/crawlers/lib/full-text-fetcher'
import { d1Query, isRemote } from './lib/d1'
import { esc } from './lib/sql-flush'

const SUPPORTED_SOURCES: SourceType[] = ['naver_blog', 'naver_cafe', 'ddg_search']

const args = process.argv.slice(2)
const SOURCE_ARG = args.find((a) => a.startsWith('--source='))?.split('=')[1] ?? 'all'
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '100', 10)
const CONCURRENCY = parseInt(
  args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? '4',
  10,
)
const SLEEP_MS = parseInt(args.find((a) => a.startsWith('--sleep='))?.split('=')[1] ?? '300', 10)
const STATUS_FILTER = args.find((a) => a.startsWith('--status='))?.split('=')[1] ?? 'pending'
const OUTPUT_DIR =
  args.find((a) => a.startsWith('--output-dir='))?.split('=')[1] ?? '/tmp/fetch-out'
const ROWS_PER_FILE = parseInt(
  args.find((a) => a.startsWith('--rows-per-file='))?.split('=')[1] ?? '1000',
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
  console.error(
    `unsupported --source=${SOURCE_ARG}; supported: all | ${SUPPORTED_SOURCES.join(' | ')}`,
  )
  process.exit(1)
}

const SOURCES_TO_PROCESS: SourceType[] =
  SOURCE_ARG === 'all' ? SUPPORTED_SOURCES : [SOURCE_ARG as SourceType]

interface MatchedRow {
  id: number
  source: string
  source_url: string
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function fetchPendingRows(source: SourceType, limit: number): MatchedRow[] {
  // Modulo sharding: when SHARDS > 1, each parallel worker grabs a disjoint
  // subset, so multiple processes can run without overlapping rows.
  const shardClause = SHARDS > 1 ? `AND id % ${SHARDS} = ${SHARD}` : ''
  return d1Query<MatchedRow>(`
    SELECT id, source, source_url
    FROM web_sources
    WHERE source = '${source}'
      AND full_text_status = '${esc(STATUS_FILTER)}'
      AND source_url LIKE 'http%'
      ${shardClause}
    ORDER BY id
    LIMIT ${limit}
  `)
}

// Cap full_text length to keep individual UPDATE statements under D1's
// SQLITE_TOOBIG threshold. Anything longer is downgraded to 'error' to keep
// the apply step from blowing up on a single huge row.
const MAX_FULLTEXT_BYTES = 50_000

function buildUpdate(row: MatchedRow, result: FetchResult): string {
  if (result.status === 'ok' && result.text.length > MAX_FULLTEXT_BYTES) {
    return `UPDATE web_sources SET full_text = NULL, full_text_length = ${result.contentLength}, full_text_status = 'error', full_text_fetched_at = datetime('now') WHERE id = ${row.id};`
  }
  const escapedText = result.text.replace(/'/g, "''")
  const fullTextValue = result.status === 'ok' ? `'${escapedText}'` : 'NULL'
  return `UPDATE web_sources SET full_text = ${fullTextValue}, full_text_length = ${result.contentLength}, full_text_status = '${result.status}', full_text_fetched_at = datetime('now') WHERE id = ${row.id};`
}

interface Counters {
  total: number
  ok: number
  blocked: number
  not_found: number
  too_short: number
  timeout: number
  error: number
}

function emptyCounters(): Counters {
  return { total: 0, ok: 0, blocked: 0, not_found: 0, too_short: 0, timeout: 0, error: 0 }
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

async function processSource(source: SourceType): Promise<Counters> {
  const counters = emptyCounters()
  const rows = fetchPendingRows(source, LIMIT)
  console.log(`\n  ${source}: ${rows.length} rows queued`)
  if (rows.length === 0) return counters

  const writer = makeChunkWriter(source)
  const startTime = Date.now()

  await new Promise<void>((resolveAll) => {
    const queue = [...rows]
    let active = 0

    const launch = (): void => {
      while (active < CONCURRENCY && queue.length > 0) {
        const row = queue.shift()
        if (!row) break
        active++
        ;(async () => {
          let result: FetchResult
          try {
            result = await fetchFullText(row.source_url, source)
          } catch (err) {
            result = {
              status: 'error',
              text: '',
              contentLength: 0,
              finalUrl: row.source_url,
              reason: err instanceof Error ? err.message : String(err),
            }
          }
          counters.total++
          counters[result.status]++
          if (counters.total % 50 === 0 || counters.total === rows.length) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
            const rate = (counters.total / parseFloat(elapsed)).toFixed(1)
            process.stdout.write(
              `    ${source} ${counters.total}/${rows.length} (${rate} req/s, ok=${counters.ok} blocked=${counters.blocked} too_short=${counters.too_short} timeout=${counters.timeout} error=${counters.error})\n`,
            )
          }
          if (!DRY_RUN) writer.push(buildUpdate(row, result))
          await sleep(SLEEP_MS)
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
  const okPct = c.total > 0 ? ((c.ok / c.total) * 100).toFixed(1) : '0.0'
  console.log(
    `  [${label}] total=${c.total} ok=${c.ok} (${okPct}%) blocked=${c.blocked} not_found=${c.not_found} too_short=${c.too_short} timeout=${c.timeout} error=${c.error}`,
  )
}

async function main(): Promise<void> {
  console.log(`\n📥 #140 fetch-matched-fulltext (fetch + emit SQL)`)
  console.log(`   query: ${isRemote ? 'remote' : 'local'} D1`)
  console.log(
    `   source=${SOURCES_TO_PROCESS.join(',')} limit=${LIMIT} concurrency=${CONCURRENCY} sleep=${SLEEP_MS}ms status=${STATUS_FILTER} ${DRY_RUN ? 'DRY-RUN' : 'WRITE-SQL'}`,
  )
  if (!DRY_RUN) {
    mkdirSync(OUTPUT_DIR, { recursive: true })
    console.log(`   output_dir=${OUTPUT_DIR} (${ROWS_PER_FILE} rows/file)`)
  }

  const totals = emptyCounters()
  for (const source of SOURCES_TO_PROCESS) {
    const c = await processSource(source)
    logCounters(source, c)
    totals.total += c.total
    totals.ok += c.ok
    totals.blocked += c.blocked
    totals.not_found += c.not_found
    totals.too_short += c.too_short
    totals.timeout += c.timeout
    totals.error += c.error
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
