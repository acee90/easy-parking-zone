/**
 * 출처 간 중복 주차장 병합 (A-4).
 *
 * 입력: data/a4/cross-source-dupes.json (scripts/find-cross-source-dupes.ts 출력)
 *   대상은 **A 등급만**, 그리고 한 lot 이 2쌍 이상에 걸린 체인은 제외한다.
 *
 * 기본 동작은 **백업 + SQL 파일 생성까지**다 (dry-run 대신 중간저장 파일).
 *   data/a4/merge-backup-<stamp>.json   흡수될 lot 행 전체 + 옮겨질 자식 행 전체
 *   data/a4/merge-<stamp>-NN.sql        적용할 SQL (크기 제한 때문에 여러 파일)
 * 내용을 확인한 뒤 --apply 로 wrangler --file 일괄 적용한다.
 *
 * ── 쌍마다 하는 일 ──
 *  1) 대표 lot 을 고른다: 유저 리뷰 있음 > 공공데이터 > MODU·HP > NV > KA > web_sources 많음
 *     (카카오 Local API 는 좌표·주소·전화 저장이 금지다 — KA 행이 흡수되는 쪽이 되는 편이 낫다)
 *  2) 자식 행을 대표로 옮긴다. 유니크 키가 있는 표는 `UPDATE OR IGNORE` 후 남은 행(=대표에 이미
 *     같은 것이 있는 중복)을 지운다.
 *  3) 흡수 lot 의 크롤 큐·진행 기록·통계 행을 지운다 (대표가 자기 것을 갖고 있다).
 *  4) lot_redirects 에 흡수→대표를 남기고 (위키 301), 흡수 lot 행을 지운다.
 *     FTS 는 트리거가 따라 지운다. D1 은 FK 를 강제하므로 옮기지 못한 자식이 있으면
 *     여기서 실패한다 — 조용히 고아가 생기지 않는다.
 *
 * Usage:
 *   bun run scripts/merge-cross-source-dupes.ts --remote            # 백업 + SQL 생성
 *   bun run scripts/merge-cross-source-dupes.ts --remote --apply    # 생성 + 적용
 */

import { execSync } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { d1Query, isRemote } from './lib/d1'

interface LotLite {
  id: string
  name: string
}
interface PairIn {
  grade: 'A' | 'B' | 'C'
  distM: number
  chained: boolean
  a: LotLite
  b: LotLite
}

/**
 * 자식 표 목록 — 2026-09-11 remote sqlite_master 기준.
 * `unique: true` 는 lot 을 포함한 유니크/PK 가 있어 옮기다 충돌할 수 있는 표다.
 */
const CHILD_TABLES: Array<{ table: string; col: string; unique: boolean }> = [
  { table: 'user_reviews', col: 'parking_lot_id', unique: false },
  { table: 'web_sources', col: 'parking_lot_id', unique: false }, // 유니크는 (source, source_id) 전역
  { table: 'parking_media', col: 'parking_lot_id', unique: true }, // (lot, url)
  { table: 'parking_votes', col: 'parking_lot_id', unique: true }, // (user, lot)
  { table: 'parking_bookmarks', col: 'parking_lot_id', unique: true }, // (user, lot)
  { table: 'review_reports', col: 'parking_lot_id', unique: false },
  { table: 'content_reports', col: 'parking_lot_id', unique: true }, // (target_type, target_id, ip)
  { table: 'nearby_places', col: 'parking_lot_id', unique: false },
  { table: 'destination_lots', col: 'parking_lot_id', unique: true }, // PK (destination, lot)
  { table: 'cafe_signal_lots', col: 'parking_lot_id', unique: true }, // PK (signal, lot)
  { table: 'web_source_ai_matches', col: 'parking_lot_id', unique: false },
  { table: 'lot_alternatives', col: 'parking_lot_id', unique: true }, // PK (lot, normalized)
  { table: 'lot_alternatives', col: 'matched_lot_id', unique: false },
  { table: 'web_sources_missed', col: 'resolved_parking_lot_id', unique: false },
  { table: 'poi_unmatched', col: 'resolved_lot_id', unique: false },
  { table: 'lot_field_edits', col: 'parking_lot_id', unique: true }, // 활성 제보 (lot, field_group)
]

const PAIRS_PER_FILE = 60
const esc = (s: string) => s.replace(/'/g, "''")
const inList = (ids: string[]) => ids.map((i) => `'${esc(i)}'`).join(',')

function sourceRank(id: string): number {
  if (/^KA-/.test(id)) return 4
  if (/^NV-/.test(id)) return 3
  if (/^(MODU|HP)-/.test(id)) return 2
  return 1 // 공공데이터
}

function main() {
  if (!isRemote) console.warn('⚠️  --remote 없이 실행 중입니다.\n')
  const dir = resolve(import.meta.dir, '../data/a4')
  const all: PairIn[] = JSON.parse(readFileSync(resolve(dir, 'cross-source-dupes.json'), 'utf-8'))
  const pairs = all.filter((p) => p.grade === 'A' && !p.chained)
  console.log(
    `A 등급 ${all.filter((p) => p.grade === 'A').length}쌍 중 체인 제외 ${pairs.length}쌍 대상`,
  )

  const ids = [...new Set(pairs.flatMap((p) => [p.a.id, p.b.id]))]

  // 실재하는 표만 쓴다 (schema.ts 에 있어도 remote 에 없는 표가 있다)
  const existing = new Set(
    d1Query<{ name: string }>(`SELECT name FROM sqlite_master WHERE type='table'`).map(
      (r) => r.name,
    ),
  )
  const children = CHILD_TABLES.filter((c) => existing.has(c.table))
  const missing = CHILD_TABLES.filter((c) => !existing.has(c.table)).map((c) => c.table)
  if (missing.length)
    console.log(`  remote 에 없는 표는 건너뜀: ${[...new Set(missing)].join(', ')}`)

  // 대표 선정 근거 — 쌍이 적어 lot 별 카운트를 한 번에 가져온다
  const reviewCnt = new Map<string, number>()
  const wsCnt = new Map<string, number>()
  for (let i = 0; i < ids.length; i += 150) {
    const chunk = inList(ids.slice(i, i + 150))
    for (const r of d1Query<{ id: string; n: number }>(
      `SELECT parking_lot_id id, COUNT(*) n FROM user_reviews WHERE parking_lot_id IN (${chunk}) GROUP BY parking_lot_id`,
    ))
      reviewCnt.set(r.id, Number(r.n))
    for (const r of d1Query<{ id: string; n: number }>(
      `SELECT parking_lot_id id, COUNT(*) n FROM web_sources WHERE parking_lot_id IN (${chunk}) GROUP BY parking_lot_id`,
    ))
      wsCnt.set(r.id, Number(r.n))
  }

  const plan = pairs.map((p) => {
    const score = (id: string) => [
      (reviewCnt.get(id) ?? 0) > 0 ? 0 : 1,
      sourceRank(id),
      -(wsCnt.get(id) ?? 0),
      id,
    ]
    const [keep, drop] = [p.a.id, p.b.id].sort((x, y) => {
      const sx = score(x)
      const sy = score(y)
      for (let i = 0; i < sx.length; i++) {
        if (sx[i] < sy[i]) return -1
        if (sx[i] > sy[i]) return 1
      }
      return 0
    })
    return {
      keep,
      drop,
      distM: p.distM,
      keepName: keep === p.a.id ? p.a.name : p.b.name,
      dropName: drop === p.a.id ? p.a.name : p.b.name,
    }
  })

  const dropIds = plan.map((x) => x.drop)
  const keepIds = plan.map((x) => x.keep)
  const overlap = dropIds.filter((d) => keepIds.includes(d))
  if (overlap.length)
    throw new Error(`흡수 lot 이 다른 쌍의 대표이기도 합니다: ${overlap.join(', ')}`)

  // ── 백업: 흡수 lot 행 + 옮겨질 자식 행 전체 ──
  console.log('백업 수집 중...')
  const backup: Record<string, unknown> = { createdAt: new Date().toISOString(), plan }
  const lotRows: unknown[] = []
  for (let i = 0; i < dropIds.length; i += 150) {
    lotRows.push(
      ...d1Query(`SELECT * FROM parking_lots WHERE id IN (${inList(dropIds.slice(i, i + 150))})`),
    )
  }
  backup.parking_lots = lotRows
  for (const c of children) {
    const rows: unknown[] = []
    for (let i = 0; i < dropIds.length; i += 150) {
      rows.push(
        ...d1Query(
          `SELECT * FROM ${c.table} WHERE ${c.col} IN (${inList(dropIds.slice(i, i + 150))})`,
        ),
      )
    }
    backup[`${c.table}.${c.col}`] = rows
  }
  if (lotRows.length !== dropIds.length) {
    throw new Error(
      `흡수 lot 행 ${lotRows.length} ≠ 계획 ${dropIds.length} — 덤프 이후 바뀐 행이 있습니다`,
    )
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)
  const backupPath = resolve(dir, `merge-backup-${stamp}.json`)
  writeFileSync(backupPath, JSON.stringify(backup))
  const movedTotal = children.reduce(
    (a, c) => a + ((backup[`${c.table}.${c.col}`] as unknown[]) ?? []).length,
    0,
  )
  console.log(`백업: ${backupPath} (lot ${lotRows.length}행, 자식 ${movedTotal}행)`)

  // ── SQL ──
  const stmtsFor = ({ keep, drop }: { keep: string; drop: string }) => {
    const k = esc(keep)
    const d = esc(drop)
    const s: string[] = [`-- ${drop} → ${keep}`]
    for (const c of children) {
      if (c.unique) {
        s.push(`UPDATE OR IGNORE ${c.table} SET ${c.col} = '${k}' WHERE ${c.col} = '${d}';`)
        s.push(`DELETE FROM ${c.table} WHERE ${c.col} = '${d}';`)
      } else if (c.table === 'web_sources') {
        // matched_at 을 지금으로 올린다. 크론의 재계산 스테이지(scheduled.ts)는
        // `ws.matched_at > 마지막 스코어링 AND > s.computed_at` 인 lot 만 다시 계산하는데,
        // 옮긴 행은 옛 matched_at 을 그대로 갖고 있어 대표 lot 이 영영 재계산되지 않는다.
        s.push(
          `UPDATE web_sources SET parking_lot_id = '${k}', matched_at = datetime('now') WHERE parking_lot_id = '${d}';`,
        )
      } else {
        s.push(`UPDATE ${c.table} SET ${c.col} = '${k}' WHERE ${c.col} = '${d}';`)
      }
    }
    s.push(`DELETE FROM crawl_queue WHERE lot_id = '${d}';`)
    s.push(`DELETE FROM crawl_progress WHERE crawler_id LIKE '%:${d}';`)
    s.push(
      `UPDATE crawl_progress SET last_parking_lot_id = '${k}' WHERE last_parking_lot_id = '${d}';`,
    )
    s.push(`DELETE FROM parking_lot_stats WHERE parking_lot_id = '${d}';`)
    // 이미 흡수 lot 을 가리키던 리다이렉트도 새 대표로 (연쇄 301 방지)
    s.push(`UPDATE lot_redirects SET to_id = '${k}' WHERE to_id = '${d}';`)
    s.push(
      `INSERT OR REPLACE INTO lot_redirects (from_id, to_id, reason) VALUES ('${d}', '${k}', 'cross_source_dupe');`,
    )
    s.push(`DELETE FROM parking_lots WHERE id = '${d}';`)
    return s.join('\n')
  }

  const files: string[] = []
  for (let i = 0; i < plan.length; i += PAIRS_PER_FILE) {
    const n = String(files.length + 1).padStart(2, '0')
    const path = resolve(dir, `merge-${stamp}-${n}.sql`)
    writeFileSync(
      path,
      `-- 출처 간 중복 병합 (A-4) ${n}\n-- 백업: ${backupPath}\n\n${plan
        .slice(i, i + PAIRS_PER_FILE)
        .map(stmtsFor)
        .join('\n\n')}\n`,
    )
    files.push(path)
  }
  writeFileSync(resolve(dir, `merge-${stamp}-plan.json`), JSON.stringify(plan, null, 1))
  console.log(`SQL ${files.length}개 생성:\n  ${files.join('\n  ')}`)

  if (!process.argv.includes('--apply')) {
    console.log('\n적용하려면 --apply 를 붙여 다시 실행하세요.')
    return
  }

  for (const f of files) {
    console.log(`\n적용: ${f}`)
    execSync(
      `bunx wrangler d1 execute parking-db ${isRemote ? '--remote' : '--local'} --yes --file "${f}"`,
      {
        stdio: 'inherit',
      },
    )
  }

  // ── 사후 검증 ──
  const left = d1Query<{ n: number }>(
    `SELECT COUNT(*) n FROM parking_lots WHERE id IN (${inList(dropIds)})`,
  )[0]?.n
  const redirects = d1Query<{ n: number }>(
    `SELECT COUNT(*) n FROM lot_redirects WHERE from_id IN (${inList(dropIds)})`,
  )[0]?.n
  console.log(
    `\n남은 흡수 lot 행: ${left} (기대 0) / 리다이렉트: ${redirects} (기대 ${dropIds.length})`,
  )
  if (Number(left) !== 0 || Number(redirects) !== dropIds.length) process.exit(1)
}

main()
