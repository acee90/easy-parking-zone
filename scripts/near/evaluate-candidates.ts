/**
 * 목적지 후보 평가 → 발행 SQL (#166 1단계)
 *
 * destinations 에 행을 만드는 유일한 경로다. 게이트(src/lib/near/gate.ts)를 통과한 후보만 SQL 로 내고,
 * 탈락은 사유와 함께 JSON 으로 남긴다. DB 를 직접 쓰지 않는다 — 사람이 rejected 를 보고 나서
 * wrangler --file 로 일괄 적용한다. 크론에 넣지 않는다.
 *
 *   bun run scripts/near/evaluate-candidates.ts                 # 로컬 D1 로 평가
 *   bun run scripts/near/evaluate-candidates.ts --remote        # remote D1 로 평가 (읽기만)
 *   bun run scripts/near/evaluate-candidates.ts --in=data/near/candidates.json --limit=50
 *
 * 산출물 (data/near/):
 *   publish-YYYYMMDD-HHMM.sql   통과분. INSERT OR IGNORE + destination_lots 재계산
 *   rejected-YYYYMMDD-HHMM.json 탈락분. {name, reason, detail}
 *   twins-YYYYMMDD-HHMM.json    같은 주차장이 KA-/공공데이터로 두 번 잡힌 쌍
 *   summary-YYYYMMDD-HHMM.md    통과 수, 탈락 사유 상위 5, 적용 명령
 *
 * 다시 실행해도 안전하다: id 는 DB 의 MAX(id) 다음부터 발급하고, 이미 있는 slug 는 그 id 를 재사용한다.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { clusterByRadius } from '../../src/lib/near/cluster'
import {
  type CandidateLot,
  DEFAULT_GATE,
  distanceMeters,
  evaluateGate,
  type GateFailReason,
  type RankedLot,
} from '../../src/lib/near/gate'
import { walkMinutes } from '../../src/lib/parking-fee'
import { makeDestinationSlug } from '../../src/lib/slug'
import { d1Query } from '../lib/d1'
import { esc } from '../lib/sql-flush'
import type { StationCandidate } from './import-stations'

const args = process.argv.slice(2)
const arg = (k: string, d: string) => args.find((a) => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const IN = arg('in', 'data/near/candidates.json')
const LIMIT = Number.parseInt(arg('limit', '0'), 10)
const OUT_DIR = 'data/near'
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12) // YYYYMMDDHHMM
const BBOX_DEG = 0.012 // ≈1.3km. 게이트가 반경 1km 로 다시 자른다

interface LotRow {
  id: string
  name: string
  lat: number
  lng: number
  total_spaces: number | string | null
  is_free: number
  base_fee: number | string | null
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim() && v !== 'null') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/** bbox 안 주차장 + 그 주차장에 붙은 web_source 중 목적지 이름을 담은 글 1건 */
function loadLots(c: StationCandidate): CandidateLot[] {
  const s = c.lat - BBOX_DEG
  const n = c.lat + BBOX_DEG
  const w = c.lng - BBOX_DEG
  const e = c.lng + BBOX_DEG
  const lots = d1Query<LotRow>(
    `SELECT id, name, lat, lng, total_spaces, is_free, base_fee FROM parking_lots
     WHERE lat BETWEEN ${s} AND ${n} AND lng BETWEEN ${w} AND ${e}`,
  )
  if (lots.length === 0) return []
  // 역 이름은 '역' 을 뗀 형태로도 찾는다: "석촌역" → "석촌역" OR "석촌 역"
  const stem = c.name.replace(/역$/, '')
  const ids = lots.map((l) => `'${esc(l.id)}'`).join(',')
  const ev = d1Query<{ parking_lot_id: string; id: number }>(
    `SELECT parking_lot_id, MAX(id) AS id FROM web_sources
     WHERE parking_lot_id IN (${ids})
       AND relevance_score >= 40 AND filter_passed_v2 = 1
       AND (title LIKE '%${esc(c.name)}%' OR title LIKE '%${esc(stem)} 역%'
            OR content LIKE '%${esc(c.name)}%')
     GROUP BY parking_lot_id`,
  )
  const evidence = new Map(ev.map((r) => [r.parking_lot_id, r.id]))
  return lots.map((l) => ({
    id: l.id,
    name: l.name,
    lat: l.lat,
    lng: l.lng,
    totalSpaces: num(l.total_spaces) ?? 0,
    isFree: l.is_free === 1,
    baseFee: num(l.base_fee),
    evidenceSourceId: evidence.get(l.id) ?? null,
  }))
}

function nextIdAllocator() {
  const row = d1Query<{ m: string | null }>(`SELECT MAX(id) AS m FROM destinations`)[0]
  let n = row?.m ? Number.parseInt(row.m.slice(2), 10) : 0
  const existing = d1Query<{ id: string; name: string; lat: number; lng: number }>(
    `SELECT id, name, lat, lng FROM destinations`,
  )
  // 같은 이름 + 500m 안이면 같은 목적지로 보고 id 를 재사용한다. 이름만으로 판단하면
  // 서울 용산역과 대구 용산역이 한 id 로 합쳐진다.
  return (name: string, lat: number, lng: number): string => {
    const hit = existing.find(
      (e) => e.name === name && distanceMeters(e.lat, e.lng, lat, lng) <= 500,
    )
    if (hit) return hit.id
    n += 1
    const id = `D-${String(n).padStart(4, '0')}`
    existing.push({ id, name, lat, lng })
    return id
  }
}

function lineAliases(c: StationCandidate): string[] {
  const out = new Set<string>()
  const stem = c.name.replace(/역$/, '')
  out.add(`${stem} 역`)
  for (const line of c.lines) {
    out.add(`${c.name} ${line}`)
    out.add(`${c.name}${line}`)
  }
  return [...out]
}

function main() {
  const candidates = JSON.parse(readFileSync(IN, 'utf-8')) as StationCandidate[]
  const targets = LIMIT > 0 ? candidates.slice(0, LIMIT) : candidates
  console.log(`후보 ${targets.length}건 평가 시작 (${IN})`)

  const passed: {
    c: StationCandidate
    lots: RankedLot[]
    freeCount: number
    evidenceCount: number
  }[] = []
  const rejected: { name: string; key: string; reason: GateFailReason; detail: string }[] = []
  const twins: { candidate: string; pairs: [string, string][] }[] = []

  for (const c of targets) {
    const lots = loadLots(c)
    const r = evaluateGate(c, lots, DEFAULT_GATE)
    if (!r.pass) {
      rejected.push({ name: c.name, key: c.key, reason: r.reason, detail: r.detail })
      continue
    }
    if (r.twins.length) twins.push({ candidate: c.name, pairs: r.twins })
    passed.push({
      c,
      lots: r.lots,
      freeCount: r.freeCount,
      evidenceCount: r.lots.filter((l) => l.evidenceSourceId).length,
    })
  }

  // 50m 클러스터링: 같은 자리의 후보는 대표 하나만 발행하고 나머지는 alias
  const cluster = clusterByRadius(
    passed.map((p) => ({
      key: p.c.key,
      name: p.c.name,
      lat: p.c.lat,
      lng: p.c.lng,
      evidenceCount: p.evidenceCount,
    })),
  )
  const byKey = new Map(passed.map((p) => [p.c.key, p]))
  const allocate = nextIdAllocator()
  // D1 execute --file 은 명시적 BEGIN/COMMIT 을 받지 않는다 (파일 전체가 한 배치로 실행된다)
  const sqlLines: string[] = []
  let published = 0

  for (const repKey of cluster.representatives) {
    const p = byKey.get(repKey)
    if (!p) continue
    const id = allocate(p.c.name, p.c.lat, p.c.lng)
    const slug = makeDestinationSlug(p.c.name, id)
    const absorbed = passed.filter(
      (q) => q.c.key !== repKey && cluster.representativeOf.get(q.c.key) === repKey,
    )
    const aliases = new Set<string>(lineAliases(p.c))
    for (const a of absorbed) {
      aliases.add(a.c.name)
      for (const x of lineAliases(a.c)) aliases.add(x)
    }

    sqlLines.push(
      `INSERT OR IGNORE INTO destinations (id, name, slug, category, lat, lng, address, source, source_id, cluster_id, lot_count, free_count)
       VALUES ('${id}', '${esc(p.c.name)}', '${esc(slug)}', 'station', ${p.c.lat}, ${p.c.lng},
               ${p.c.address ? `'${esc(p.c.address)}'` : 'NULL'}, '${esc(p.c.source)}',
               ${p.c.sourceIds.length ? `'${esc(p.c.sourceIds.join('|'))}'` : 'NULL'}, '${id}', ${p.lots.length}, ${p.freeCount});`,
      `UPDATE destinations SET lot_count = ${p.lots.length}, free_count = ${p.freeCount}, updated_at = datetime('now') WHERE id = '${id}';`,
      `DELETE FROM destination_lots WHERE destination_id = '${id}';`,
    )
    for (const l of p.lots) {
      const ev = l.evidenceSourceId ? `'web_source:${l.evidenceSourceId}'` : 'NULL'
      sqlLines.push(
        `INSERT INTO destination_lots (destination_id, parking_lot_id, distance_m, walk_minutes, evidence, rank)
         VALUES ('${id}', '${esc(l.id)}', ${l.distanceM}, ${walkMinutes(l.distanceM / 1000)}, ${ev}, ${l.rank});`,
      )
    }
    for (const a of aliases) {
      const kind = a.includes('호선') || a.includes('선') ? 'line' : 'spacing'
      sqlLines.push(
        `INSERT OR IGNORE INTO destination_aliases (destination_id, alias, kind) VALUES ('${id}', '${esc(a)}', '${kind}');`,
      )
    }
    published += 1
  }

  mkdirSync(OUT_DIR, { recursive: true })
  const sqlPath = `${OUT_DIR}/publish-${stamp}.sql`
  const rejPath = `${OUT_DIR}/rejected-${stamp}.json`
  const twinPath = `${OUT_DIR}/twins-${stamp}.json`
  const sumPath = `${OUT_DIR}/summary-${stamp}.md`
  writeFileSync(sqlPath, sqlLines.join('\n'))
  writeFileSync(rejPath, JSON.stringify(rejected, null, 2))
  writeFileSync(twinPath, JSON.stringify(twins, null, 2))

  const reasonCounts = new Map<string, number>()
  for (const r of rejected) reasonCounts.set(r.reason, (reasonCounts.get(r.reason) ?? 0) + 1)
  const top = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const absorbedCount = passed.length - cluster.representatives.length
  const summary = [
    `# 목적지 평가 결과 ${stamp}`,
    '',
    `- 후보: ${targets.length}`,
    `- 게이트 통과: ${passed.length} (그중 50m 클러스터로 흡수 ${absorbedCount})`,
    `- **발행: ${published}**`,
    `- 탈락: ${rejected.length}`,
    '',
    '## 탈락 사유 상위',
    ...top.map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## 적용',
    '```bash',
    `npx wrangler d1 execute parking-db --remote --file=${sqlPath}`,
    '```',
    '',
    `탈락 목록: ${rejPath}`,
  ].join('\n')
  writeFileSync(sumPath, summary)
  console.log(summary)
}

main()
