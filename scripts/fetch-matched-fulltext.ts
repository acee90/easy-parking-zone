/**
 * #140 Phase B-2 — populate web_sources.full_text for matched rows by calling
 * the #139 fetcher library.
 *
 * Reads `web_sources` rows whose `full_text_status` matches `--status=...`
 * (default `pending`), filtered by `--source=...` (default cycles through all
 * three supported sources), runs `fetchFullText` with a small concurrency
 * budget, and writes results back in batches.
 *
 * UPDATEs are batched (25 per wrangler invocation) via a temp SQL file.
 *
 * Usage:
 *   bun run scripts/fetch-matched-fulltext.ts --remote --source=naver_blog --limit=100
 *   bun run scripts/fetch-matched-fulltext.ts --remote --source=ddg_search --limit=1000 --concurrency=3 --sleep=1500
 *   bun run scripts/fetch-matched-fulltext.ts --remote --source=all --limit=22000   # full sweep
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type FetchResult,
  fetchFullText,
  type SourceType,
} from '../src/server/crawlers/lib/full-text-fetcher'
import { d1ExecFile, d1Query, isRemote } from './lib/d1'
import { esc } from './lib/sql-flush'

const SUPPORTED_SOURCES: SourceType[] = ['naver_blog', 'naver_cafe', 'ddg_search']

const args = process.argv.slice(2)
const SOURCE_ARG = args.find((a) => a.startsWith('--source='))?.split('=')[1] ?? 'all'
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '100', 10)
const CONCURRENCY = parseInt(
  args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? '3',
  10,
)
const SLEEP_MS = parseInt(args.find((a) => a.startsWith('--sleep='))?.split('=')[1] ?? '1500', 10)
const STATUS_FILTER = args.find((a) => a.startsWith('--status='))?.split('=')[1] ?? 'pending'
const FLUSH_EVERY = parseInt(
  args.find((a) => a.startsWith('--flush-every='))?.split('=')[1] ?? '25',
  10,
)
const DRY_RUN = args.includes('--dry-run')

if (SOURCE_ARG !== 'all' && !SUPPORTED_SOURCES.includes(SOURCE_ARG as SourceType)) {
  console.error(
    `unsupported --source=${SOURCE_ARG}; supported: all | ${SUPPORTED_SOURCES.join(' | ')}`,
  )
  process.exit(1)
}

const SOURCES_TO_PROCESS: SourceType[] =
  SOURCE_ARG === 'all' ? SUPPORTED_SOURCES : [SOURCE_ARG as SourceType]

const TMP_DIR = mkdtempSync(join(tmpdir(), 'fetch-matched-'))

interface MatchedRow {
  id: number
  source: string
  source_url: string
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function fetchPendingRows(source: SourceType, limit: number): MatchedRow[] {
  return d1Query<MatchedRow>(`
    SELECT id, source, source_url
    FROM web_sources
    WHERE source = '${source}'
      AND full_text_status = '${esc(STATUS_FILTER)}'
      AND source_url LIKE 'http%'
    ORDER BY id
    LIMIT ${limit}
  `)
}

function buildUpdate(row: MatchedRow, result: FetchResult): string {
  const escapedText = result.text.replace(/'/g, "''")
  const fullTextValue = result.status === 'ok' ? `'${escapedText}'` : 'NULL'
  return `UPDATE web_sources SET full_text = ${fullTextValue}, full_text_length = ${result.contentLength}, full_text_status = '${result.status}', full_text_fetched_at = datetime('now') WHERE id = ${row.id};`
}

function flush(buffer: string[], batchIndex: number): void {
  if (DRY_RUN || buffer.length === 0) return
  const path = join(TMP_DIR, `batch-${batchIndex}.sql`)
  writeFileSync(path, buffer.join('\n'), 'utf-8')
  d1ExecFile(path)
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

async function processSource(source: SourceType): Promise<Counters> {
  const counters = emptyCounters()
  const rows = fetchPendingRows(source, LIMIT)
  console.log(`\n  ${source}: ${rows.length} rows queued`)
  if (rows.length === 0) return counters

  let buffer: string[] = []
  let batchIndex = 0

  return new Promise((resolveAll) => {
    const queue = [...rows]
    let active = 0

    const tryFlush = (): void => {
      if (buffer.length >= FLUSH_EVERY) {
        const toFlush = buffer
        buffer = []
        try {
          flush(toFlush, batchIndex++)
        } catch (err) {
          console.error(
            `      DB flush 실패 batch=${batchIndex - 1}:`,
            err instanceof Error ? err.message : err,
          )
        }
      }
    }

    const launch = (): void => {
      while (active < CONCURRENCY && queue.length > 0) {
        const row = queue.shift()
        if (!row) break
        active++
        ;(async () => {
          const start = Date.now()
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
          const dur = Date.now() - start
          counters.total++
          counters[result.status]++
          process.stdout.write(
            `    [${counters.total}/${rows.length}] ${result.status} (${result.contentLength}자, ${dur}ms) — id=${row.id}\n`,
          )
          buffer.push(buildUpdate(row, result))
          tryFlush()
          await sleep(SLEEP_MS)
          active--
          if (queue.length === 0 && active === 0) {
            // final flush
            try {
              flush(buffer, batchIndex++)
            } catch (err) {
              console.error(
                `      final DB flush 실패:`,
                err instanceof Error ? err.message : err,
              )
            }
            buffer = []
            resolveAll(counters)
          } else {
            launch()
          }
        })()
      }
    }
    launch()
  })
}

function logCounters(label: string, c: Counters): void {
  const okPct = c.total > 0 ? ((c.ok / c.total) * 100).toFixed(1) : '0.0'
  console.log(
    `  [${label}] total=${c.total} ok=${c.ok} (${okPct}%) blocked=${c.blocked} not_found=${c.not_found} too_short=${c.too_short} timeout=${c.timeout} error=${c.error}`,
  )
}

async function main(): Promise<void> {
  console.log(`\n📥 #140 fetch-matched-fulltext — ${isRemote ? 'remote' : 'local'} D1`)
  console.log(
    `   source=${SOURCES_TO_PROCESS.join(',')} limit=${LIMIT} concurrency=${CONCURRENCY} sleep=${SLEEP_MS}ms status=${STATUS_FILTER} flush_every=${FLUSH_EVERY} ${DRY_RUN ? 'DRY-RUN' : 'WRITE'}`,
  )
  console.log(`   tmp=${TMP_DIR}`)

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
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
