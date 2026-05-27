/**
 * youtube-video-verifier agent 결과를 D1에 적용.
 *
 * 입력: data/youtube-verify/youtube-verify-input*-verified.json (agent 출력)
 *
 * 처리:
 *   filter_passed=true → web_sources INSERT (raw_source_id, parking_lot_id=hint_lot_id)
 *                      + parking_media INSERT (thumbnail은 videoId에서 동적 구성)
 *                      + ws_raw 갱신 (filter_passed=1, matched_at=now)
 *   filter_passed=false → ws_raw 갱신 (filter_passed=0, filter_removed_by, matched_at=now)
 *
 * Usage:
 *   bun run scripts/apply-youtube-verify.ts --remote --input-dir=data/youtube-verify
 *   bun run scripts/apply-youtube-verify.ts --remote --input=data/youtube-verify/foo-verified.json
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { d1ExecFile, d1Query, isRemote } from './lib/d1'
import { esc } from './lib/sql-flush'

const args = process.argv.slice(2)
const INPUT_DIR =
  args.find((a) => a.startsWith('--input-dir='))?.split('=')[1] ?? 'data/youtube-verify'
const SINGLE_INPUT = args.find((a) => a.startsWith('--input='))?.split('=')[1]
const OUTPUT_SQL =
  args.find((a) => a.startsWith('--output-sql='))?.split('=')[1] ?? 'data/youtube-verify/apply.sql'

interface VerifyResult {
  raw_id: number
  filter_passed: boolean
  removed_by: string | null
  reason?: string
}

interface VerifyOutput {
  results: VerifyResult[]
  stats?: unknown
}

interface RawRow {
  id: number
  source_url: string
  title: string
  content: string
  author: string | null
  published_at: string | null
  search_lot_hint: string
}

function extractVideoId(url: string): string | null {
  const m = url.match(/[?&]v=([^&]+)/)
  return m?.[1] ?? null
}

function loadInputs(): VerifyResult[] {
  if (SINGLE_INPUT) {
    const path = resolve(import.meta.dir, '..', SINGLE_INPUT)
    const data = JSON.parse(readFileSync(path, 'utf-8')) as VerifyOutput
    return data.results
  }

  const dir = resolve(import.meta.dir, '..', INPUT_DIR)
  const files = readdirSync(dir).filter((f) => f.endsWith('-verified.json'))
  const all: VerifyResult[] = []
  for (const f of files) {
    const data = JSON.parse(readFileSync(resolve(dir, f), 'utf-8')) as VerifyOutput
    all.push(...data.results)
  }
  return all
}

function fetchRawRows(rawIds: number[]): Map<number, RawRow> {
  const result = new Map<number, RawRow>()
  if (rawIds.length === 0) return result

  // 청크로 IN 절 분할 (SQLite 한도)
  const CHUNK = 500
  for (let i = 0; i < rawIds.length; i += CHUNK) {
    const chunk = rawIds.slice(i, i + CHUNK).join(',')
    const rows = d1Query<RawRow>(`
      SELECT id, source_url, title, content, author, published_at, search_lot_hint
      FROM web_sources_raw
      WHERE id IN (${chunk})
    `)
    for (const r of rows) result.set(r.id, r)
  }
  return result
}

function main(): void {
  console.log(`\n📥 apply-youtube-verify — ${isRemote ? 'remote' : 'local'} D1`)

  const results = loadInputs()
  console.log(`   loaded ${results.length} verify results`)

  const rawIds = results.map((r) => r.raw_id)
  const rawMap = fetchRawRows(rawIds)
  console.log(`   fetched ${rawMap.size} raw rows`)

  const sqls: string[] = []
  let passedCount = 0
  let failedCount = 0
  let skippedCount = 0

  for (const r of results) {
    const raw = rawMap.get(r.raw_id)
    if (!raw) {
      skippedCount++
      continue
    }

    if (r.filter_passed) {
      // 1. web_sources INSERT
      const sourceId = `yt-${raw.id}:${raw.search_lot_hint}`
      sqls.push(
        `INSERT OR IGNORE INTO web_sources ` +
          `(parking_lot_id, source, source_id, title, content, source_url, author, published_at, raw_source_id, relevance_score) ` +
          `VALUES ('${esc(raw.search_lot_hint)}', 'youtube_video', '${esc(sourceId)}', ` +
          `'${esc(raw.title)}', '${esc(raw.content)}', '${esc(raw.source_url)}', ` +
          `${raw.author ? `'${esc(raw.author)}'` : 'NULL'}, ` +
          `${raw.published_at ? `'${esc(raw.published_at)}'` : 'NULL'}, ` +
          `${raw.id}, 100);`,
      )

      // 2. parking_media INSERT (thumbnail은 videoId에서)
      const videoId = extractVideoId(raw.source_url)
      if (videoId) {
        const thumbnailUrl = `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`
        sqls.push(
          `INSERT OR IGNORE INTO parking_media ` +
            `(parking_lot_id, media_type, url, title, thumbnail_url, description) ` +
            `VALUES ('${esc(raw.search_lot_hint)}', 'youtube', '${esc(raw.source_url)}', ` +
            `'${esc(raw.title)}', '${esc(thumbnailUrl)}', '${esc(raw.content)}');`,
        )
      }

      // 3. ws_raw 갱신 (통과)
      sqls.push(
        `UPDATE web_sources_raw SET filter_passed = 1, ai_filtered_at = datetime('now'), ` +
          `matched_at = datetime('now') WHERE id = ${raw.id};`,
      )
      passedCount++
    } else {
      // ws_raw 갱신 (제거)
      const reason = r.removed_by ?? 'unspecified'
      sqls.push(
        `UPDATE web_sources_raw SET filter_passed = 0, ` +
          `filter_removed_by = '${esc(reason)}', ai_filtered_at = datetime('now'), ` +
          `matched_at = datetime('now') WHERE id = ${raw.id};`,
      )
      failedCount++
    }
  }

  const sqlPath = resolve(import.meta.dir, '..', OUTPUT_SQL)
  mkdirSync(dirname(sqlPath), { recursive: true })
  writeFileSync(sqlPath, sqls.join('\n') + '\n', 'utf-8')

  console.log(`✅ wrote ${sqlPath} (${sqls.length} statements)`)
  console.log(`   passed=${passedCount}, failed=${failedCount}, skipped=${skippedCount}`)
  console.log(`\n적용:`)
  console.log(`   bunx wrangler d1 execute parking-db --remote --file=${sqlPath}`)

  // 자동 적용
  if (args.includes('--apply')) {
    console.log(`\n📤 applying...`)
    d1ExecFile(sqlPath)
    console.log(`✅ applied to ${isRemote ? 'remote' : 'local'} D1`)
  }
}

main()
