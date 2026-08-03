/**
 * remote→local `web_sources_raw` 시간 기반 sync — 최근 N분 내 crawl된 raw를 추출해
 * local INSERT SQL로 emit.
 *
 * 사용 시점: `crawl-blogs.ts` / `crawl-ddg.ts` / `crawl-lot-keywords.ts`를 `--remote`로
 * 실행한 직후, /run-pipeline 흐름이 local DB 기준이므로 신규 raw를 local에 가져올 때.
 *
 * 흐름:
 *   1) remote D1에 `SELECT * FROM web_sources_raw WHERE crawled_at >= now-Nmin`
 *   2) 결과 행을 `INSERT OR IGNORE INTO web_sources_raw (...) VALUES (...)`로 dump
 *   3) 호출자가 local에 apply
 *
 * Usage:
 *   bun run scripts/sync-recent-raw.ts [minutes] [out_path]
 *   예) bun run scripts/sync-recent-raw.ts 15 /tmp/sync.sql
 *
 * 기본값: minutes=15, out=/tmp/sync-recent.sql
 *
 * 한계 ([[feedback_local_crawl_raw_id_divergence]]):
 *   - `INSERT OR IGNORE`로 INSERT하면 AUTOINCREMENT id가 local/remote에서 어긋남.
 *     즉 동일 raw 행이 local에선 id=A, remote에선 id=B로 존재할 수 있음.
 *   - 따라서 local에서 만든 `web_sources.raw_source_id`(local raw id)를 remote에 그대로
 *     적용하면 FK 위반. remote용 INSERT는 `raw_source_id=NULL`로 처리해야 함
 *     (`force-attach-by-hint.ts`가 이 변환 담당).
 */
import { execSync } from 'child_process'
import { writeFileSync } from 'fs'

const mins = process.argv[2] ?? '15'
const out = process.argv[3] ?? '/tmp/sync-recent.sql'

const raw = execSync(
  `bunx wrangler d1 execute parking-db --remote --json --command "SELECT * FROM web_sources_raw WHERE crawled_at >= datetime('now','-${mins} minutes') ORDER BY id"`,
  { encoding: 'utf-8', maxBuffer: 200 * 1024 * 1024 },
)
const rows: Record<string, unknown>[] = JSON.parse(raw)[0]?.results ?? []
console.log('rows:', rows.length)
if (!rows.length) process.exit(0)

const cols = Object.keys(rows[0])
const sqlVal = (v: unknown) =>
  v === null || v === undefined
    ? 'NULL'
    : typeof v === 'number'
      ? String(v)
      : `'${String(v).replace(/'/g, "''")}'`
const stmts = rows.map(
  (r) =>
    `INSERT OR IGNORE INTO web_sources_raw (${cols.join(', ')}) VALUES (${cols.map((c) => sqlVal(r[c])).join(', ')});`,
)
writeFileSync(out, stmts.join('\n'))
console.log('wrote', stmts.length, 'INSERTs ->', out)
