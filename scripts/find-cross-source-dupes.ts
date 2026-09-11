/**
 * 출처 간 중복 주차장 후보 찾기 (A-4). **읽기 전용** — DB 를 바꾸지 않는다.
 *
 * 입력: data/a4/lots.json (parking_lots 덤프: id,name,address,lat,lng,type,total_spaces,is_free)
 *   만들기: bunx wrangler d1 execute parking-db --remote --json \
 *             --command "SELECT id,name,address,lat,lng,type,total_spaces,is_free FROM parking_lots;"
 * 출력: data/a4/cross-source-dupes.json  (쌍 + 근거 + 등급)
 *       data/a4/cross-source-dupes-sample.md (등급별 무작위 표본, 사람 검수용)
 *
 * ── 판정 규칙 ──
 * MODU 내부 중복 정리(2026-09-08)에서 배운 두 가지를 그대로 가져온다.
 *  1) **쌍 단위로 자른다.** 그룹의 최대 거리로 자르면, 멀리 떨어진 한 행 때문에
 *     0m·동일 면수인 진짜 중복까지 통째로 빠진다(홈플러스 강동점 사례).
 *  2) **거리만으로는 부족하다.** 밀집 지역엔 이름이 다른 별개 주차장이 수십 m 안에 흔하다
 *     (60m 이내 MODU 쌍 2,510건 중 이름까지 같은 건 64건). 이름 일치가 필수다.
 *
 * 등급:
 *  A (자동 확정 후보) — 거리 ≤ 60m, 정규화 이름 완전 일치, 반대 신호 없음
 *  B (보류)          — 거리 ≤ 60m, 운영사 브랜드를 떼면 일치하거나 한쪽이 다른 쪽을 포함
 *  C (보류)          — 거리 ≤ 30m, 이름은 다르지만 정규화 주소가 같음
 * 반대 신호(있으면 A 에서 B 로 내린다):
 *  - 공영/민영이 엇갈림
 *  - 번호·동·차수 표기가 다름 (제1/제2, A동/B동, 1차/2차)
 *  - 면수가 둘 다 있고 2배 이상 차이
 *
 * 같은 출처끼리의 쌍(예: MODU-MODU)은 이미 한 차례 정리했으므로 기본적으로 제외한다.
 * `--include-same-source` 로 포함할 수 있다.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

interface Lot {
  id: string
  name: string
  address: string | null
  lat: number
  lng: number
  type: string | null
  total_spaces: number | null
  is_free: number | null
}

type Grade = 'A' | 'B' | 'C'

interface Pair {
  grade: Grade
  a: Lot
  b: Lot
  distM: number
  reasons: string[]
  holdReasons: string[]
}

const MAX_DIST_M = 60
const ADDR_ONLY_DIST_M = 30
const includeSameSource = process.argv.includes('--include-same-source')

// ── 출처 ──
export function sourceOf(id: string): string {
  const m = id.match(/^(KA|NV|MODU|HP)-/)
  return m ? m[1] : 'PUB' // 공공데이터: 000-1-000001
}

// ── 이름 정규화 ──
/** 운영사 브랜드. 떼고 비교하면 B 등급 근거가 된다 (A 는 아님 — 브랜드가 다르면 다른 운영일 수 있다). */
const BRANDS = [
  '투루파킹',
  '아마노',
  '나이스파크',
  '하이파킹',
  '카카오T',
  'Tmap주차',
  '티맵주차',
  '케이엠파크',
  '다온파킹',
  '어반포트',
  '파킹클라우드',
  '윌슨파킹',
  '한국주차',
  '모두의주차장',
  'GS파킹',
  'AJ파크',
  '발렛파킹',
]

/** 번호·동·차수 표기. 두 이름에서 이게 다르면 별개 주차장일 가능성이 높다. */
function ordinalTokens(name: string): string {
  const toks = name.match(
    /(제?\d+(?:차|동|호|공영|주차장|번)?|[A-Z]동|[가-힣]동\b|지하|지상|옥상|별관|본관|신관|구관)/g,
  )
  return (toks ?? []).join('|')
}

function publicPrivate(name: string): 'pub' | 'priv' | null {
  if (/공영/.test(name)) return 'pub'
  if (/민영/.test(name)) return 'priv'
  return null
}

export function normName(name: string): string {
  return name
    .normalize('NFC')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '') // 괄호 안 부가설명: "(방문주차 불가)"
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\s+/g, '')
    .replace(/주차장/g, '')
    .replace(/주차타워/g, '')
    .replace(/[·.,\-_/]/g, '')
}

function stripBrand(n: string): string {
  let s = n
  for (const b of BRANDS) s = s.replace(b.toLowerCase(), '')
  return s
}

// ── 주소 정규화 (scripts/archive/merge-duplicates.ts 규칙을 따른다) ──
const REGION_ABBR: Array<[RegExp, string]> = [
  [/서울특별시/g, '서울'],
  [/부산광역시/g, '부산'],
  [/대구광역시/g, '대구'],
  [/인천광역시/g, '인천'],
  [/광주광역시/g, '광주'],
  [/대전광역시/g, '대전'],
  [/울산광역시/g, '울산'],
  [/세종특별자치시/g, '세종'],
  [/제주특별자치도/g, '제주'],
  [/경기도/g, '경기'],
  [/강원특별자치도|강원도/g, '강원'],
  [/충청북도/g, '충북'],
  [/충청남도/g, '충남'],
  [/전북특별자치도|전라북도/g, '전북'],
  [/전라남도/g, '전남'],
  [/경상북도/g, '경북'],
  [/경상남도/g, '경남'],
]

export function normAddr(addr: string | null): string {
  if (!addr) return ''
  let s = addr
  for (const [re, to] of REGION_ABBR) s = s.replace(re, to)
  s = s.replace(/\s*\([^)]*\)\s*/g, '')
  return s.replace(/\s+/g, '')
}

// ── 거리 ──
function distM(a: Lot, b: Lot): number {
  const R = 6371000
  const dLat = ((b.lat - a.lat) * Math.PI) / 180
  const dLng = ((b.lng - a.lng) * Math.PI) / 180
  const la1 = (a.lat * Math.PI) / 180
  const la2 = (b.lat * Math.PI) / 180
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

// ── 판정 ──
export function judge(a: Lot, b: Lot, d: number): Pair | null {
  const na = normName(a.name)
  const nb = normName(b.name)
  if (!na || !nb) return null

  const reasons: string[] = []
  const holdReasons: string[] = []

  // 반대 신호
  const pa = publicPrivate(a.name)
  const pb = publicPrivate(b.name)
  if (pa && pb && pa !== pb) holdReasons.push('공영/민영 엇갈림')
  if (ordinalTokens(a.name) !== ordinalTokens(b.name)) holdReasons.push('번호·동·차수 표기 다름')
  const sa = a.total_spaces ?? 0
  const sb = b.total_spaces ?? 0
  if (sa > 0 && sb > 0 && Math.max(sa, sb) / Math.min(sa, sb) >= 2) {
    holdReasons.push(`면수 차이 ${sa}/${sb}`)
  }

  let grade: Grade | null = null
  if (d <= MAX_DIST_M && na === nb) {
    reasons.push('정규화 이름 일치')
    grade = holdReasons.length ? 'B' : 'A'
  } else if (d <= MAX_DIST_M) {
    const ba = stripBrand(na)
    const bb = stripBrand(nb)
    // 짧은 이름끼리의 포함 관계는 우연이 많다 ("중앙" ⊂ "중앙일보사")
    const minLen = Math.min(ba.length, bb.length)
    if (ba && ba === bb) {
      reasons.push('브랜드 제거 후 이름 일치')
      grade = 'B'
    } else if (minLen >= 4 && (ba.includes(bb) || bb.includes(ba))) {
      reasons.push('이름 포함 관계')
      grade = 'B'
    }
  }
  if (!grade && d <= ADDR_ONLY_DIST_M) {
    const aa = normAddr(a.address)
    const ab = normAddr(b.address)
    if (aa && aa === ab) {
      reasons.push('정규화 주소 일치 (이름 다름)')
      grade = 'C'
    }
  }
  if (!grade) return null

  return { grade, a, b, distM: Math.round(d), reasons, holdReasons }
}

// ── 격자로 근접 쌍만 비교 (54K² 를 피한다) ──
function* nearbyPairs(lots: Lot[]): Generator<[Lot, Lot, number]> {
  // 위도 0.001° ≈ 111m. 셀 크기 0.001° 면 인접 3×3 셀만 보면 60m 는 충분히 덮는다.
  const CELL = 0.001
  const grid = new Map<string, Lot[]>()
  const key = (la: number, ln: number) => `${Math.floor(la / CELL)}:${Math.floor(ln / CELL)}`
  for (const l of lots) {
    if (!Number.isFinite(l.lat) || !Number.isFinite(l.lng)) continue
    const k = key(l.lat, l.lng)
    const arr = grid.get(k)
    if (arr) arr.push(l)
    else grid.set(k, [l])
  }
  for (const l of lots) {
    if (!Number.isFinite(l.lat) || !Number.isFinite(l.lng)) continue
    const ci = Math.floor(l.lat / CELL)
    const cj = Math.floor(l.lng / CELL)
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        for (const o of grid.get(`${ci + di}:${cj + dj}`) ?? []) {
          if (o.id <= l.id) continue // 쌍마다 한 번
          const d = distM(l, o)
          if (d <= MAX_DIST_M) yield [l, o, d]
        }
      }
    }
  }
}

function main() {
  const dir = resolve(import.meta.dir, '../data/a4')
  const lots: Lot[] = JSON.parse(readFileSync(resolve(dir, 'lots.json'), 'utf-8'))
  console.log(`주차장 ${lots.length}곳`)

  const pairs: Pair[] = []
  let compared = 0
  for (const [a, b, d] of nearbyPairs(lots)) {
    compared++
    if (!includeSameSource && sourceOf(a.id) === sourceOf(b.id)) continue
    const p = judge(a, b, d)
    if (p) pairs.push(p)
  }

  const by = (g: Grade) => pairs.filter((p) => p.grade === g)
  console.log(`60m 이내 쌍 ${compared}건 비교 → 후보 ${pairs.length}쌍`)
  console.log(
    `  A(자동 확정 후보) ${by('A').length} / B(보류) ${by('B').length} / C(보류) ${by('C').length}`,
  )

  // 한 lot 이 여러 A 쌍에 걸리면 체인 병합 위험 — 표시만 해두고 판정은 사람에게
  const aCount = new Map<string, number>()
  for (const p of by('A')) {
    aCount.set(p.a.id, (aCount.get(p.a.id) ?? 0) + 1)
    aCount.set(p.b.id, (aCount.get(p.b.id) ?? 0) + 1)
  }
  const chained = by('A').filter(
    (p) => (aCount.get(p.a.id) ?? 0) > 1 || (aCount.get(p.b.id) ?? 0) > 1,
  )
  console.log(`  A 중 한 lot 이 2쌍 이상에 걸린 것(체인) ${chained.length}`)

  // 출처 조합 분포
  const combo = new Map<string, number>()
  for (const p of by('A')) {
    const k = [sourceOf(p.a.id), sourceOf(p.b.id)].sort().join('↔')
    combo.set(k, (combo.get(k) ?? 0) + 1)
  }
  console.log(
    `  A 출처 조합: ${[...combo]
      .sort((x, y) => y[1] - x[1])
      .map(([k, n]) => `${k} ${n}`)
      .join(' · ')}`,
  )

  mkdirSync(dir, { recursive: true })
  writeFileSync(
    resolve(dir, 'cross-source-dupes.json'),
    JSON.stringify(
      pairs.map((p) => ({
        grade: p.grade,
        distM: p.distM,
        reasons: p.reasons,
        holdReasons: p.holdReasons,
        chained: (aCount.get(p.a.id) ?? 0) > 1 || (aCount.get(p.b.id) ?? 0) > 1,
        a: p.a,
        b: p.b,
      })),
      null,
      1,
    ),
  )

  // 사람 검수용 표본 — 시드 고정이라 다시 돌려도 같은 표본이 나온다
  let seed = 20260911
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const sample = (arr: Pair[], n: number) =>
    [...arr]
      .map((p) => [rand(), p] as const)
      .sort((x, y) => x[0] - y[0])
      .slice(0, n)
      .map(([, p]) => p)

  const row = (p: Pair) =>
    `| ${p.distM}m | \`${p.a.id}\` ${p.a.name} | \`${p.b.id}\` ${p.b.name} | ${p.a.total_spaces ?? '—'}/${p.b.total_spaces ?? '—'} | ${[...p.reasons, ...p.holdReasons].join(', ')} |`
  const table = (arr: Pair[]) =>
    ['| 거리 | lot A | lot B | 면수 | 근거 |', '|---|---|---|---|---|', ...arr.map(row)].join('\n')

  const md = [
    '# 출처 간 중복 후보 — 검수 표본',
    '',
    `생성: ${new Date().toISOString()} · 전체 ${pairs.length}쌍 (A ${by('A').length} / B ${by('B').length} / C ${by('C').length})`,
    '',
    '## A 등급 무작위 30쌍 — 게이트: 오탐 1건 이하',
    '',
    table(sample(by('A'), 30)),
    '',
    '## B 등급 무작위 15쌍 (참고)',
    '',
    table(sample(by('B'), 15)),
    '',
    '## C 등급 무작위 10쌍 (참고)',
    '',
    table(sample(by('C'), 10)),
    '',
  ].join('\n')
  writeFileSync(resolve(dir, 'cross-source-dupes-sample.md'), md)
  console.log(`\n저장: ${resolve(dir, 'cross-source-dupes.json')}`)
  console.log(`표본: ${resolve(dir, 'cross-source-dupes-sample.md')}`)
}

if (import.meta.main) main()
