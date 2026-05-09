/**
 * web_sources_raw fulltext fetcher — raw-fulltext-batch.ts (Workers Cron)의 스크립트 버전.
 *
 * web_sources_raw에서 full_text_status='pending'인 항목을 fetch하여
 * UPDATE SQL을 --output-dir에 emit한다.
 *
 * Usage:
 *   bun run scripts/fetch-raw-fulltext.ts --remote --limit=30 --concurrency=3
 *   bun run scripts/fetch-raw-fulltext.ts --remote --limit=30 --output-dir=/tmp/raw-ft-out
 *   # 이후 apply:
 *   for f in /tmp/raw-ft-out/*.sql; do bunx wrangler d1 execute parking-db --remote --file="$f"; done
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type FetchResult,
  fetchFullText,
  type SourceType,
} from '../src/server/crawlers/lib/full-text-fetcher'
import { d1Query, isRemote } from './lib/d1'

const args = process.argv.slice(2)
const LIMIT = parseInt(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? '100', 10)
const CONCURRENCY = parseInt(
  args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ?? '3',
  10,
)
const SLEEP_MS = parseInt(args.find((a) => a.startsWith('--sleep='))?.split('=')[1] ?? '500', 10)
const OUTPUT_DIR =
  args.find((a) => a.startsWith('--output-dir='))?.split('=')[1] ?? '/tmp/raw-ft-out'
const ROWS_PER_FILE = 500
const MAX_FULLTEXT_BYTES = 50_000

if (!isRemote) {
  console.error('⚠️  web_sources_raw는 remote D1 전용. --remote 플래그를 추가하세요.')
  process.exit(1)
}

mkdirSync(OUTPUT_DIR, { recursive: true })

interface PendingRow {
  id: number
  source: string
  source_url: string
}

function buildUpdate(row: PendingRow, result: FetchResult): string {
  const status =
    result.status === 'ok' && result.text.length > MAX_FULLTEXT_BYTES ? 'error' : result.status
  const escapedText = result.text.replace(/'/g, "''")
  const fullTextValue = status === 'ok' ? `'${escapedText}'` : 'NULL'
  return `UPDATE web_sources_raw SET full_text = ${fullTextValue}, full_text_status = '${status}', full_text_fetched_at = datetime('now') WHERE id = ${row.id};`
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function main(): Promise<void> {
  const rows = d1Query<PendingRow>(
    `SELECT id, source, source_url FROM web_sources_raw
     WHERE full_text_status = 'pending' AND source_url LIKE 'http%'
     ORDER BY id LIMIT ${LIMIT}`,
  )
  console.log(`📥 대상: ${rows.length}건 (limit=${LIMIT})`)
  if (rows.length === 0) return

  const buf: string[] = []
  let chunkIdx = 0
  const counters = { total: 0, ok: 0, blocked: 0, not_found: 0, too_short: 0, timeout: 0, error: 0 }

  const flushBuf = (): void => {
    if (buf.length === 0) return
    const path = join(OUTPUT_DIR, `raw-ft-${String(chunkIdx++).padStart(4, '0')}.sql`)
    writeFileSync(path, buf.join('\n'), 'utf-8')
    console.log(`  → ${path} (${buf.length}건)`)
    buf.length = 0
  }

  const queue = [...rows]
  let active = 0

  await new Promise<void>((resolveAll) => {
    const launch = (): void => {
      while (active < CONCURRENCY && queue.length > 0) {
        const row = queue.shift()!
        active++
        const source = row.source as SourceType
        fetchFullText(row.source_url, source)
          .then((result) => {
            counters.total++
            counters[result.status as keyof typeof counters]++
            buf.push(buildUpdate(row, result))
            process.stdout.write(
              `\r  진행: ${counters.total}/${rows.length}  ok:${counters.ok}  blocked:${counters.blocked}  `,
            )
            if (buf.length >= ROWS_PER_FILE) flushBuf()
          })
          .catch(() => {
            counters.total++
            counters.error++
            buf.push(
              buildUpdate(row, {
                status: 'error',
                text: '',
                contentLength: 0,
                finalUrl: row.source_url,
                reason: 'exception',
              }),
            )
          })
          .finally(async () => {
            if (SLEEP_MS > 0) await sleep(SLEEP_MS)
            active--
            launch()
            if (active === 0 && queue.length === 0) resolveAll()
          })
      }
    }
    launch()
    if (rows.length === 0) resolveAll()
  })

  console.log()
  flushBuf()

  console.log('\n✅ 완료')
  console.log(
    `  ok: ${counters.ok}, blocked: ${counters.blocked}, not_found: ${counters.not_found}, too_short: ${counters.too_short}, timeout: ${counters.timeout}, error: ${counters.error}`,
  )
  console.log(`\n다음 단계:`)
  console.log(
    `  for f in ${OUTPUT_DIR}/*.sql; do bunx wrangler d1 execute parking-db --remote --file="\\$f"; done`,
  )
}

main().catch(console.error)
