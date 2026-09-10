/**
 * GA4 트래픽 기준으로 크롤 우선순위를 고정한다 (A-2).
 *
 * 문제: crawl_queue 의 priority 는 reliability 만 본다. 사람이 실제로 보고 있는 주차장인지는
 * 모른다. 그래서 PV 가 높은데 근거가 0건인 페이지가 계속 비어 있다.
 *
 * 입력: GA4 에서 내보낸 CSV. 헤더에 다음 중 하나가 있으면 된다.
 *   - lot id 열: `lot_id` | `id`
 *   - 또는 경로 열: `page_path` | `pagePath` | `path` | `url`  (…/wiki/이름-KA-123 에서 id 추출)
 *   - 조회수 열: `pv` | `views` | `screenPageViews` | `pageviews`  (없으면 전부 1로 본다)
 *
 * 기본 동작은 SQL 파일 생성까지다. 내용을 확인하고 --apply 로 적용한다.
 *
 * Usage:
 *   bun run scripts/pin-crawl-priority.ts --remote --csv data/traffic-lots-20260910.csv
 *   bun run scripts/pin-crawl-priority.ts --remote --csv ... --min-pv 20 --apply
 *   bun run scripts/pin-crawl-priority.ts --remote --unpin          # 고정 전체 해제
 */

import { execSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { parseIdFromSlug } from '../src/lib/slug'
import { d1Query, isRemote } from './lib/d1'

/** 고정 우선순위. 0(=근거 0건)보다 앞서야 하므로 음수를 쓴다. */
const PINNED_PRIORITY = -1
const CRAWLERS = ['naver_blogs', 'ddg', 'youtube', 'brave_search'] as const

function arg(name: string): string | null {
  const i = process.argv.indexOf(name)
  return i >= 0 ? (process.argv[i + 1] ?? null) : null
}

/** 따옴표를 고려한 최소 CSV 파서. GA4 내보내기는 값에 쉼표가 들어갈 수 있다. */
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') quoted = false
      else cur += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim())
}

function readTrafficCsv(path: string): Map<string, number> {
  const text = readFileSync(path, 'utf-8')
  // GA4 UI 내보내기는 맨 위에 주석(#)과 빈 줄을 붙인다
  const lines = text
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('#'))
  if (lines.length < 2) throw new Error('CSV 에 데이터 행이 없습니다')

  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase())
  const idCol = header.findIndex((h) => h === 'lot_id' || h === 'id')
  const pathCol = header.findIndex(
    (h) => h === 'page_path' || h === 'pagepath' || h === 'path' || h === 'url',
  )
  const pvCol = header.findIndex(
    (h) => h === 'pv' || h === 'views' || h === 'screenpageviews' || h === 'pageviews',
  )
  if (idCol < 0 && pathCol < 0) {
    throw new Error(`lot id 열도 경로 열도 없습니다. 헤더: ${header.join(', ')}`)
  }

  const pv = new Map<string, number>()
  let skipped = 0
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line)
    let id: string | null = idCol >= 0 ? (cells[idCol] ?? null) : null
    if (!id && pathCol >= 0) {
      // "/wiki/서울역-공영주차장-118-2-000081" 또는 전체 URL
      const raw = decodeURIComponent(cells[pathCol] ?? '')
      id = parseIdFromSlug(raw.split('?')[0].replace(/\/$/, ''))
    }
    if (!id) {
      skipped++
      continue
    }
    const n = pvCol >= 0 ? Number((cells[pvCol] ?? '0').replace(/,/g, '')) || 0 : 1
    pv.set(id, (pv.get(id) ?? 0) + n)
  }
  if (skipped) console.log(`  lot id 를 못 뽑은 행 ${skipped}개는 건너뜀 (위키 외 페이지 등)`)
  return pv
}

function sqlList(ids: string[]): string {
  return ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',')
}

function emit(statements: string[], name: string): string {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  const dir = resolve(import.meta.dir, '../data')
  mkdirSync(dir, { recursive: true })
  const path = resolve(dir, `${name}-${stamp}.sql`)
  writeFileSync(path, `-- ${name} (A-2)\n-- 생성: ${new Date().toISOString()}\n\n${statements.join('\n\n')}\n`)
  console.log(`\nSQL 생성: ${path}`)
  return path
}

function apply(path: string) {
  if (!process.argv.includes('--apply')) {
    console.log('적용하려면 --apply 를 붙여 다시 실행하세요.')
    return false
  }
  console.log('\n적용 중...')
  execSync(
    `bunx wrangler d1 execute parking-db ${isRemote ? '--remote' : '--local'} --yes --file "${path}"`,
    { stdio: 'inherit' },
  )
  return true
}

function unpin() {
  const path = emit(
    [`UPDATE crawl_queue SET pinned_at = NULL WHERE pinned_at IS NOT NULL;`],
    'unpin-crawl-priority',
  )
  console.log('고정만 해제한다. priority 값은 다음 syncQueue 가 알아서 재계산한다.')
  if (apply(path)) {
    const left = d1Query(`SELECT COUNT(*) AS n FROM crawl_queue WHERE pinned_at IS NOT NULL`)
    console.log(`남은 고정 행: ${Number(left[0]?.n ?? 0)}`)
  }
}

function main() {
  if (!isRemote) {
    console.warn('⚠️  --remote 없이 실행 중입니다. 로컬 D1 에는 crawl_queue 행이 없습니다.\n')
  }

  if (process.argv.includes('--unpin')) return unpin()

  const csv = arg('--csv')
  if (!csv) {
    console.error('--csv 경로가 필요합니다. (--unpin 으로 해제만 할 수도 있습니다)')
    process.exit(1)
  }
  const minPv = Number(arg('--min-pv') ?? '1')

  console.log(`CSV 읽는 중: ${csv}`)
  const pv = readTrafficCsv(csv)
  const wanted = [...pv.entries()].filter(([, n]) => n >= minPv).sort((a, b) => b[1] - a[1])
  console.log(`  lot ${pv.size}곳 중 PV ≥ ${minPv} 인 ${wanted.length}곳`)
  if (!wanted.length) {
    console.error('대상이 없습니다.')
    process.exit(1)
  }

  // 실재 확인 + 근거 보유 현황. 이미 근거가 충분한 곳까지 앞으로 당길 이유는 없다.
  const ids = wanted.map(([id]) => id)
  const rows = d1Query<{ id: string; sources: number }>(`
    SELECT p.id, COALESCE(w.n, 0) AS sources
      FROM parking_lots p
      LEFT JOIN (SELECT parking_lot_id, COUNT(*) AS n FROM web_sources GROUP BY parking_lot_id) w
             ON w.parking_lot_id = p.id
     WHERE p.id IN (${sqlList(ids)})`)
  const known = new Map(rows.map((r) => [r.id, Number(r.sources)]))

  const missing = ids.filter((id) => !known.has(id))
  const targets = ids.filter((id) => (known.get(id) ?? -1) === 0)
  const alreadyHas = ids.filter((id) => (known.get(id) ?? 0) > 0)

  console.log(`  DB 에 없는 id ${missing.length}개 (슬러그가 바뀌었거나 삭제된 주차장)`)
  console.log(`  이미 web_sources 가 있는 곳 ${alreadyHas.length}개 — 고정 대상에서 제외`)
  console.log(`  ▶ 고정 대상 ${targets.length}곳`)
  if (!targets.length) {
    console.error('고정할 대상이 없습니다.')
    process.exit(1)
  }

  // 미리보기 — 무엇이 앞으로 가는지 눈으로 확인할 수 있게
  const preview = targets.slice(0, 10)
  const names = d1Query<{ id: string; name: string }>(
    `SELECT id, name FROM parking_lots WHERE id IN (${sqlList(preview)})`,
  )
  const nameOf = new Map(names.map((r) => [r.id, r.name]))
  console.log('\n  상위 10곳:')
  for (const id of preview) {
    console.log(`    ${String(pv.get(id)).padStart(5)} PV  ${id}  ${nameOf.get(id) ?? '(이름 없음)'}`)
  }

  // 크롤러 4종 모두 앞으로 당긴다. next_at 도 지금으로 되돌려 즉시 대상으로.
  const statements = CRAWLERS.map(
    (crawler) => `UPDATE crawl_queue
   SET priority = ${PINNED_PRIORITY},
       pinned_at = datetime('now'),
       next_at = datetime('now', '-1 day')
 WHERE crawler = '${crawler}'
   AND lot_id IN (${sqlList(targets)});`,
  )
  const path = emit(statements, 'pin-crawl-priority')

  if (apply(path)) {
    const after = d1Query(`
      SELECT COUNT(*) AS pinned FROM crawl_queue
       WHERE crawler = 'naver_blogs' AND pinned_at IS NOT NULL AND priority = ${PINNED_PRIORITY}`)
    console.log(`\n고정된 naver_blogs 행: ${Number(after[0]?.pinned ?? 0)} (기대 ${targets.length})`)
  }
}

main()
