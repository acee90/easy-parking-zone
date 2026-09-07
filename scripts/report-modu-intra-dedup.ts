/**
 * 이미 등록된 MODU 주차장 중 배치 내부 중복을 찾아 정리 목록을 만든다.
 *
 * sync-modu.ts가 배치 내부 dedup 없이 돌던 시절에 같은 주차장이 서로 다른
 * parkinglotSeq로 여러 번 등록됐다. 그 잔여분을 찾아 파일로만 남긴다 (DB 미변경).
 *
 * 사용법:
 *   bun run scripts/report-modu-intra-dedup.ts --remote
 *
 * 출력:
 *   data/modu-intra-dedup-YYYYMMDD.md   — 그룹별 유지/삭제 근거
 *   data/modu-intra-dedup-YYYYMMDD.sql  — 30m 이내 그룹만 DELETE
 *
 * SQL은 사람이 .md를 확인한 뒤 직접 적용한다:
 *   bunx wrangler d1 execute parking-db --remote --file=data/modu-intra-dedup-YYYYMMDD.sql
 */
import { writeFileSync } from 'fs'
import { resolve } from 'path'
import { d1Query, isRemote } from './lib/d1'
import { haversineMeters } from './lib/geo'
import { normalizeLotName } from './lib/place-match'

/** 이 거리 안이면 자동 적용 대상, 넘으면 사람이 확인 */
const AUTO_APPLY_RADIUS_M = 30
/** 후보로 잡는 최대 거리 */
const CANDIDATE_RADIUS_M = 60

interface Lot {
  id: string
  name: string
  lat: number
  lng: number
  address: string
  total_spaces: number
  weekday_start: string | null
  base_fee: number | null
  phone: string | null
}

const lots = d1Query<Lot>(
  `SELECT id, name, lat, lng, address, total_spaces, weekday_start, base_fee, phone
   FROM parking_lots WHERE id LIKE 'MODU-%'`,
)

// 삭제하면 같이 사라지는 데이터가 붙은 lot — 이런 그룹은 병합 판단이 필요해 보류한다
const attached = new Set<string>([
  ...d1Query<{ id: string }>(
    "SELECT parking_lot_id AS id FROM parking_lot_stats WHERE parking_lot_id LIKE 'MODU-%'",
  ).map((r) => r.id),
  ...d1Query<{ id: string }>(
    "SELECT DISTINCT parking_lot_id AS id FROM web_sources WHERE parking_lot_id LIKE 'MODU-%'",
  ).map((r) => r.id),
])

const operationConflicts = (a: string, b: string) => {
  const pub = (s: string) => s.includes('공영')
  const pri = (s: string) => s.includes('민영')
  return (pub(a) && pri(b)) || (pri(a) && pub(b))
}

// ── 0.001도(≈111m) 그리드로 인접 쌍만 비교 ──
const grid = new Map<string, Lot[]>()
const cell = (lat: number, lng: number) => `${Math.floor(lat / 0.001)}:${Math.floor(lng / 0.001)}`
for (const l of lots) {
  const k = cell(l.lat, l.lng)
  if (!grid.has(k)) grid.set(k, [])
  grid.get(k)?.push(l)
}

const pairs: [string, string][] = []
for (const l of lots) {
  const gy = Math.floor(l.lat / 0.001)
  const gx = Math.floor(l.lng / 0.001)
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      for (const o of grid.get(`${gy + dy}:${gx + dx}`) ?? []) {
        if (o.id >= l.id) continue
        if (normalizeLotName(o.name) !== normalizeLotName(l.name)) continue
        if (operationConflicts(o.name, l.name)) continue
        if (haversineMeters(l.lat, l.lng, o.lat, o.lng) > CANDIDATE_RADIUS_M) continue
        pairs.push([o.id, l.id])
      }
    }
  }
}

// ── 연결 요소로 묶기 (A-B, B-C면 A,B,C 한 그룹) ──
const parent = new Map<string, string>()
const find = (x: string): string => {
  const p = parent.get(x) ?? x
  if (p === x) return x
  const root = find(p)
  parent.set(x, root)
  return root
}
for (const [a, b] of pairs) {
  const ra = find(a)
  const rb = find(b)
  if (ra !== rb) parent.set(ra, rb)
}
const byId = new Map(lots.map((l) => [l.id, l]))
const groups = new Map<string, Lot[]>()
for (const id of new Set(pairs.flat())) {
  const root = find(id)
  if (!groups.has(root)) groups.set(root, [])
  const lot = byId.get(id)
  if (lot) groups.get(root)?.push(lot)
}

// ── 그룹별 생존자 선정 ──
const detailScore = (l: Lot) =>
  (l.weekday_start ? 1 : 0) + (l.base_fee !== null ? 1 : 0) + (l.phone ? 1 : 0)
const hasRoadAddress = (a: string) => /(로|길)\s*\d/.test(a)
const seq = (id: string) => Number.parseInt(id.slice('MODU-'.length), 10)

function pickSurvivor(group: Lot[]): Lot {
  return [...group].sort(
    (x, y) =>
      Number(attached.has(y.id)) - Number(attached.has(x.id)) ||
      Number(y.total_spaces > 0) - Number(x.total_spaces > 0) ||
      detailScore(y) - detailScore(x) ||
      Number(hasRoadAddress(y.address)) - Number(hasRoadAddress(x.address)) ||
      seq(x.id) - seq(y.id),
  )[0]
}

interface Row {
  name: string
  keep: Lot
  drops: Lot[]
  maxDist: number
  attachedIds: string[]
}
const apply: Row[] = []
const review: Row[] = []
const hold: Row[] = []

for (const group of groups.values()) {
  const keep = pickSurvivor(group)
  const maxDist = Math.max(
    ...group.flatMap((x) => group.map((y) => haversineMeters(x.lat, x.lng, y.lat, y.lng))),
  )
  const row: Row = {
    name: keep.name,
    keep,
    drops: group.filter((l) => l.id !== keep.id),
    maxDist,
    attachedIds: group.filter((l) => attached.has(l.id)).map((l) => l.id),
  }
  // 둘 이상에 데이터가 붙었으면 삭제가 아니라 병합이다
  if (row.attachedIds.length > 1) hold.push(row)
  else if (maxDist <= AUTO_APPLY_RADIUS_M) apply.push(row)
  else review.push(row)
}

// ── 출력 ──
const HEAD = '| 이름 | 유지 | 삭제 후보 | 최대거리 | 연결데이터 |\n|---|---|---|---|---|'
const table = (rows: Row[]) =>
  [...rows]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(
      (r) =>
        `| ${r.name} | \`${r.keep.id}\` (${r.keep.total_spaces}면) | ` +
        `${r.drops.map((d) => `${d.id}(${d.total_spaces}면)`).join(', ')} | ` +
        `${Math.round(r.maxDist)}m | ${r.attachedIds.join(',') || '-'} |`,
    )
    .join('\n')
const dropCount = (rows: Row[]) => rows.reduce((s, r) => s + r.drops.length, 0)

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const md = `# MODU 중복 등록 정리 목록 (${stamp})

\`sync-modu.ts\`가 배치 내부 중복을 안 걸러서, 같은 주차장이 서로 다른 \`parkinglotSeq\`로 여러 번 등록됐다.
생성: \`bun run scripts/report-modu-intra-dedup.ts${isRemote ? ' --remote' : ''}\`

판정 — 이름 정규화(공백·민영/공영/노상/노외/부설·"주차장" 제거) 후 일치 **AND** ${CANDIDATE_RADIUS_M}m 이내.
공영/민영이 서로 엇갈리는 쌍은 다른 주차장으로 보고 제외했다.

유지 우선순위: 연결데이터 있음 > total_spaces>0 > 상세필드(운영시간/요금/전화) 많음 > 도로명주소 > 낮은 seq.

## 1. 적용 대상 — ${AUTO_APPLY_RADIUS_M}m 이내 (${apply.length}그룹, ${dropCount(apply)}행 삭제)

${HEAD}
${table(apply)}

## 2. 검토 필요 — ${AUTO_APPLY_RADIUS_M}~${CANDIDATE_RADIUS_M}m (${review.length}그룹, ${dropCount(review)}행)

거리가 있어 실제로 별개 주차장일 수 있다. 자동 적용하지 않는다.

${HEAD}
${table(review)}

## 3. 보류 — 두 행 이상에 데이터가 붙음 (${hold.length}그룹)

단순 삭제가 아니라 병합이 필요하다.

${HEAD}
${table(hold)}
`

const sql = `-- MODU 배치 내부 중복 정리 (${stamp})
-- 대상: 이름 정규화 일치 + ${AUTO_APPLY_RADIUS_M}m 이내, 연결 데이터 없음 (${dropCount(apply)}행)
-- 생성: scripts/report-modu-intra-dedup.ts
DELETE FROM parking_lots WHERE id IN (
${apply.flatMap((r) => r.drops.map((d) => `  '${d.id}'`)).join(',\n')}
);
`

const mdPath = resolve(import.meta.dir, `../data/modu-intra-dedup-${stamp}.md`)
const sqlPath = resolve(import.meta.dir, `../data/modu-intra-dedup-${stamp}.sql`)
writeFileSync(mdPath, md)
writeFileSync(sqlPath, sql)

console.log(`MODU ${lots.length.toLocaleString()}건 중 중복 그룹 ${groups.size}개`)
console.log(`  적용 대상: ${apply.length}그룹 / ${dropCount(apply)}행`)
console.log(`  검토 필요: ${review.length}그룹 / ${dropCount(review)}행`)
console.log(`  보류:      ${hold.length}그룹`)
console.log(`\n${mdPath}\n${sqlPath}`)
