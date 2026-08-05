/**
 * Stage F — resolved_new missed 후보 → Kakao 확정 → 신규 parking_lots 등록
 *
 * 계획: docs/exec-plans/missed-web-sources-new-parking-lots.plan.md (Stage F, 다음 후보 #5)
 *
 * 흐름 ("네이버로 찾고, 카카오로 확정"):
 *   1) resolution_status IS NULL(active) missed 행을 normalized name으로 그룹핑 + classify
 *   2) eligible 후보에 Naver Local Search → resolvePlace → label='resolved_new'만 통과
 *   3) Kakao 키워드검색으로 확정 — Naver best 좌표 인근(≤--kakao-radius)의 주차장 결과를
 *      찾아 KA-{id} 채번 + WGS84 좌표 확보. 없으면 review_required(자동 insert 안 함).
 *   4) dedup — KA-id가 이미 있거나 좌표가 기존 lot ≤--dedup-radius면 신규 insert 대신
 *      resolved_existing_lot 재연결 마커로 처리.
 *   5) 신규 lot insert + 후보의 missed 행을 web_sources로 승격(관련성 게이트) +
 *      resolution_status='resolved_new_lot' / resolved_parking_lot_id 마킹.
 *
 * 출력 SQL: parking_lots INSERT → web_sources INSERT → web_sources_missed UPDATE 순.
 * dry-run 기본. --apply 시 로컬 적용. remote 반영은 생성된 SQL을 --remote --file로.
 *
 * Usage:
 *   bun run scripts/register-new-lots.ts --limit 100              # 샘플 dry-run
 *   bun run scripts/register-new-lots.ts                          # 전체 dry-run
 *   bun run scripts/register-new-lots.ts --apply                  # 전체 + 로컬 적용
 *
 * 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET, KAKAO_REST_API_KEY
 */
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { scoreBlogRelevance, stripHtml } from '../src/server/crawlers/lib/scoring'
import { d1ExecFile, d1Query } from './lib/d1'
import { haversineMeters } from './lib/geo'
import {
  isKakaoParking,
  type KakaoPlace,
  parseKakaoCoords,
  searchKakaoKeyword,
} from './lib/kakao-api'
import { classify, NOISE_TYPES, normalizeName, SEARCH_ELIGIBLE_TYPES } from './lib/missed-classify'
import { isInKorea, searchNaverLocal } from './lib/naver-api'
import {
  extractHints,
  hasNameTokenMatch,
  loadExistingLots,
  nearestLot,
  resolvePlace,
} from './lib/place-match'
import { sqlVal } from './lib/sql-flush'

// ── CLI ──
const args = process.argv.slice(2)
function getNumArg(name: string, fallback: number): number {
  const i = args.indexOf(name)
  const v = i >= 0 ? args[i + 1] : ''
  return v ? parseInt(v, 10) : fallback
}
const APPLY = args.includes('--apply')
const LIMIT_ELIGIBLE = getNumArg('--limit', 0) // 0 = eligible 전량
const REQUEST_DELAY_MS = getNumArg('--delay', 150)
const DEDUP_RADIUS_M = getNumArg('--dedup-radius', 60)
const KAKAO_RADIUS_M = getNumArg('--kakao-radius', 80) // Naver best ↔ Kakao 결과 좌표 허용 오차
const MIN_RELEVANCE = getNumArg('--min-relevance', 40) // web_sources 승격 게이트
const todayTag = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const OUT_SQL = `data/new-lots-${todayTag}.sql`
const OUT_MD = `data/new-lots-review-${todayTag}.md`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const PARKING_RE = /(주차장|파킹|parking)/i
const buildQuery = (name: string) => (PARKING_RE.test(name) ? name : `${name} 주차장`)

interface MissedRow {
  id: number
  missed_lot_name: string
  source: string
  source_id: string
  title: string
  content: string
  source_url: string
  author: string | null
  published_at: string | null
  raw_source_id: number | null
  sentiment_score: number | null
  ai_difficulty_keywords: string | null
}

interface Candidate {
  normalized: string
  rows: MissedRow[]
  hintText: string
}

function loadActive(): MissedRow[] {
  return d1Query<MissedRow>(
    `SELECT id, missed_lot_name, source, source_id, title, content, source_url,
            author, published_at, raw_source_id, sentiment_score, ai_difficulty_keywords
     FROM web_sources_missed WHERE resolution_status IS NULL`,
  )
}

function groupByNormalized(rows: MissedRow[]): Candidate[] {
  const map = new Map<string, Candidate>()
  for (const r of rows) {
    const normalized = normalizeName(r.missed_lot_name)
    if (!normalized) continue
    const key = normalized.toLowerCase()
    const c = map.get(key)
    if (c) {
      c.rows.push(r)
      if (c.hintText.length < 4000) c.hintText += ` ${r.title} ${r.content}`
    } else {
      map.set(key, { normalized, rows: [r], hintText: `${r.title} ${r.content}` })
    }
  }
  return [...map.values()]
}

/** "OO 주차장 전기차충전소" 같은 자식 POI 접미사 */
const EV_SUFFIX_RE = /\s*(전기차?충전소|충전소)\s*$/i
const isEvChildPoi = (name: string) => EV_SUFFIX_RE.test(name)

/**
 * Naver best 좌표 인근(≤radius)의 Kakao 주차장 결과를 확정.
 * 동일 위치(≤ ~20m)에 EV 접미사 없는 부모 POI가 있으면 그쪽 우선 (Kakao는 종종
 * 같은 주차장에 EV 충전소를 별도 자식 POI로 등록해 검색결과 상위에 노출함).
 */
function confirmWithKakao(
  naverLat: number,
  naverLng: number,
  kakaoResults: KakaoPlace[],
  radiusM: number,
): KakaoPlace | null {
  const candidates: { p: KakaoPlace; d: number; isEv: boolean }[] = []
  for (const p of kakaoResults) {
    if (!isKakaoParking(p)) continue
    const { lat, lng } = parseKakaoCoords(p)
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue
    const d = haversineMeters(naverLat, naverLng, lat, lng)
    if (d <= radiusM) candidates.push({ p, d, isEv: isEvChildPoi(p.place_name) })
  }
  if (candidates.length === 0) return null
  // EV 아닌 결과 우선, 그 안에서 최근접
  candidates.sort((a, b) => Number(a.isEv) - Number(b.isEv) || a.d - b.d)
  return candidates[0].p
}

/** 주소에서 시/구/군 토큰 추출 (광역시·특별시·특별자치도 제외). 없으면 빈문자열. */
function regionPrefix(address: string): string {
  for (const part of address.split(/\s+/)) {
    if (/(특별시|광역시|특별자치도)$/.test(part)) continue
    if (/(시|구|군)$/.test(part)) return part
  }
  return ''
}

const nameKey = (s: string) => s.replace(/\s+/g, '').toLowerCase()

/**
 * 최종 lot 이름 결정:
 *   1) Kakao place_name에서 EV 자식 POI 접미사 제거
 *   2) 정제된 이름이 기존 DB lot 이름과 충돌(정확일치)하면 주소의 시/구/군 prefix
 */
function finalLotName(
  kakaoPlaceName: string,
  address: string,
  existingNameKeys: Set<string>,
): string {
  let name = stripHtml(kakaoPlaceName).replace(EV_SUFFIX_RE, '').trim()
  if (!name) name = stripHtml(kakaoPlaceName).trim() // 극단적 폴백
  if (existingNameKeys.has(nameKey(name))) {
    const prefix = regionPrefix(address)
    if (prefix && !name.startsWith(prefix)) name = `${prefix} ${name}`
  }
  return name
}

/** type: 노상/노외/부설 추론 (명확하지 않으면 부설) */
function inferType(name: string, category: string): string {
  const s = `${name} ${category}`
  if (/노상/.test(s)) return '노상'
  if (/(공영|노외|공공)/.test(s)) return '노외'
  return '부설'
}

/**
 * 신규 lot 좌표 결정 — **Naver 1순위, Kakao 2순위**.
 *
 * ID는 Kakao만 발급할 수 있어(Naver Local API는 placeId를 반환하지 않음)
 * ID 출처와 좌표 출처가 갈린다. 좌표를 Naver로 두는 이유:
 *   - 로드뷰·지도가 모두 네이버라, 좌표도 네이버 기준이어야 파노라마가 제자리에 잡힌다
 *   - Kakao POI 좌표는 건물/부지 중심점이라 출입구와 어긋나는 사례가 많다
 *
 * confirmWithKakao()가 두 좌표가 KAKAO_RADIUS_M 이내임을 이미 보장하므로,
 * 어느 쪽을 쓰든 같은 장소를 가리킨다.
 */
function pickLotCoords(
  naver: { lat: number; lng: number },
  kakao: { lat: number; lng: number },
): { lat: number; lng: number; source: 'naver_local' | 'kakao_keyword' } {
  if (Number.isFinite(naver.lat) && Number.isFinite(naver.lng) && isInKorea(naver.lat, naver.lng)) {
    return { lat: naver.lat, lng: naver.lng, source: 'naver_local' }
  }
  return { lat: kakao.lat, lng: kakao.lng, source: 'kakao_keyword' }
}

function lotInsert(
  p: KakaoPlace,
  lotId: string,
  name: string,
  coords: { lat: number; lng: number; source: string },
): string {
  const { lat, lng, source } = coords
  const address = p.road_address_name || p.address_name
  const cols = [
    'id',
    'name',
    'type',
    'address',
    'lat',
    'lng',
    'total_spaces',
    'is_free',
    'auto_difficulty_score',
    'phone',
    'verified_source',
    'verified_at',
    'created_at',
    'updated_at',
  ]
  const vals = [
    lotId,
    name,
    inferType(name, p.category_name),
    address,
    lat,
    lng,
    0,
    0,
    3.0,
    p.phone || null,
    source,
    "datetime('now')",
    "datetime('now')",
    "datetime('now')",
  ]
  const formatted = vals.map((v) =>
    typeof v === 'string' && v.startsWith('datetime(') ? v : sqlVal(v as string | number | null),
  )
  return `INSERT OR IGNORE INTO parking_lots (${cols.join(', ')}) VALUES (${formatted.join(', ')});`
}

// relink-existing-missed / run-pipeline-149 buildInsertSql과 동일 컬럼. ai_summary는 NULL(후속 regen).
function webSourceInsert(r: MissedRow, lotId: string, score: number): string {
  const cols = [
    'parking_lot_id',
    'source',
    'source_id',
    'title',
    'content',
    'source_url',
    'author',
    'published_at',
    'relevance_score',
    'raw_source_id',
    'sentiment_score',
    'ai_difficulty_keywords',
    'ai_summary',
    'ai_summary_updated_at',
  ]
  const vals = [
    lotId,
    r.source,
    `${r.source_id}:${lotId}`,
    stripHtml(r.title),
    stripHtml(r.content),
    r.source_url,
    r.author,
    r.published_at,
    score,
    r.raw_source_id,
    r.sentiment_score,
    r.ai_difficulty_keywords,
    null,
    null,
  ]
    .map(sqlVal)
    .join(', ')
  return `INSERT OR IGNORE INTO web_sources (${cols.join(', ')}) VALUES (${vals});`
}

function missedUpdate(rowIds: number[], status: string, lotId: string): string {
  const ids = rowIds.join(',')
  return `UPDATE web_sources_missed SET resolution_status='${status}', resolved_parking_lot_id='${lotId.replace(/'/g, "''")}', resolved_at=datetime('now') WHERE id IN (${ids});`
}

async function main() {
  console.log(
    `\n🅿️  신규 lot 등록 (resolved_new → Kakao 확정) — ${APPLY ? 'APPLY(로컬)' : 'DRY-RUN'}`,
  )
  console.log(
    `  kakao-radius=${KAKAO_RADIUS_M}m  dedup-radius=${DEDUP_RADIUS_M}m  min-relevance=${MIN_RELEVANCE}\n`,
  )

  const rows = loadActive()
  const candidates = groupByNormalized(rows)
  const eligible = candidates
    .filter((c) => {
      const { type } = classify(c.normalized)
      return !NOISE_TYPES.has(type) && SEARCH_ELIGIBLE_TYPES.has(type)
    })
    .sort((a, b) => b.rows.length - a.rows.length)
  const targets = LIMIT_ELIGIBLE > 0 ? eligible.slice(0, LIMIT_ELIGIBLE) : eligible
  console.log(
    `  NULL-active 행 ${rows.length} → 후보 ${candidates.length} → eligible ${eligible.length}(검색 ${targets.length})`,
  )

  const lots = loadExistingLots()
  const existingIds = new Set(lots.map((l) => l.id))
  const existingNameKeys = new Set(lots.map((l) => nameKey(l.name)))
  console.log(`  기존 parking_lots ${lots.length.toLocaleString()}개 로드. 검색 시작...\n`)

  const lotStmts: string[] = []
  const wsStmts: string[] = []
  const missedStmts: string[] = []
  const f = {
    resolved_new: 0,
    ambiguous_new: 0,
    all_existing: 0,
    negative: 0,
    name_gated: 0,
    kakao_confirmed: 0,
    kakao_miss: 0,
    new_insert: 0,
    existing_collision: 0,
    ws_promoted: 0,
    ws_gated: 0,
  }
  const newSamples: string[] = []
  interface NewLotReview {
    query: string
    lotId: string
    name: string
    type: string
    address: string
    lat: number
    lng: number
    phone: string
    rows: number
    wsPromoted: number
    nearestExistingM: number | null
    urls: string[]
  }
  const newLots: NewLotReview[] = []

  for (let i = 0; i < targets.length; i++) {
    const c = targets[i]
    const query = buildQuery(c.normalized)
    const hints = extractHints(c.hintText)
    try {
      const naverItems = await searchNaverLocal(query, 5)
      const o = resolvePlace(c.normalized, naverItems, lots, hints, DEDUP_RADIUS_M)
      f[o.label]++
      if (o.label !== 'resolved_new' || !o.best) {
        await sleep(REQUEST_DELAY_MS)
        continue
      }

      // 이름토큰 게이트 — 신규 생성은 좌표가 진실을 보장하지 못하므로 결과명이
      // 후보 핵심토큰을 실제로 포함해야 한다. (region_score만 통과한 '같은 동네 다른 lot' 차단)
      if (!hasNameTokenMatch(c.normalized, o.best.name)) {
        f.name_gated++
        await sleep(REQUEST_DELAY_MS)
        continue
      }

      // Kakao 확정
      const kakaoResults = await searchKakaoKeyword(query, 15)
      const match = confirmWithKakao(o.best.lat, o.best.lng, kakaoResults, KAKAO_RADIUS_M)
      if (!match) {
        f.kakao_miss++
        await sleep(REQUEST_DELAY_MS)
        continue
      }
      f.kakao_confirmed++

      const lotId = `KA-${match.id}`
      // 좌표는 Naver 우선(o.best), Kakao는 폴백. ID만 Kakao에서 가져온다.
      const coords = pickLotCoords(o.best, parseKakaoCoords(match))
      const { lat, lng } = coords
      const near = nearestLot(lat, lng, lots)
      const collides = existingIds.has(lotId) || (near !== null && near.dist <= DEDUP_RADIUS_M)

      if (collides) {
        // 이미 DB에 있는 lot → 재연결 마커 (web_sources 링크는 relink 트랙이 담당)
        f.existing_collision++
        const existingLotId = existingIds.has(lotId) ? lotId : near!.lot.id
        missedStmts.push(
          missedUpdate(
            c.rows.map((r) => r.id),
            'resolved_existing_lot',
            existingLotId,
          ),
        )
        await sleep(REQUEST_DELAY_MS)
        continue
      }

      // 신규 lot insert
      f.new_insert++
      const lotAddr = match.road_address_name || match.address_name
      const lotName = finalLotName(match.place_name, lotAddr, existingNameKeys)
      lotStmts.push(lotInsert(match, lotId, lotName, coords))

      // web_sources 승격 (관련성 게이트)
      let promotedHere = 0
      for (const r of c.rows) {
        const score = scoreBlogRelevance(r.title, r.content, lotName, lotAddr)
        if (score >= MIN_RELEVANCE) {
          wsStmts.push(webSourceInsert(r, lotId, score))
          f.ws_promoted++
          promotedHere++
        } else {
          f.ws_gated++
        }
      }
      missedStmts.push(
        missedUpdate(
          c.rows.map((r) => r.id),
          'resolved_new_lot',
          lotId,
        ),
      )

      newLots.push({
        query,
        lotId,
        name: lotName,
        type: inferType(lotName, match.category_name),
        address: lotAddr,
        lat,
        lng,
        phone: match.phone || '',
        rows: c.rows.length,
        wsPromoted: promotedHere,
        nearestExistingM: o.best.existing_dist_m,
        urls: c.rows.map((r) => r.source_url),
      })

      // 신규 lot을 이번 배치 dedup 풀에 추가 (동일 좌표 후보 중복 insert 방지)
      lots.push({ id: lotId, name: lotName, lat, lng })
      existingIds.add(lotId)
      existingNameKeys.add(nameKey(lotName))

      if (newSamples.length < 20) {
        newSamples.push(
          `    "${query}" → ${lotName} @ ${lotAddr} [${lotId}, ${c.rows.length}행, 인근기존 ${o.best.existing_dist_m}m]`,
        )
      }
    } catch (e: unknown) {
      console.log(`\n  ⚠️  "${query}" 실패: ${e instanceof Error ? e.message : String(e)}`)
    }
    if ((i + 1) % 50 === 0 || i + 1 === targets.length) {
      process.stdout.write(`\r  진행: ${i + 1}/${targets.length}  신규 ${f.new_insert}`.padEnd(50))
    }
    await sleep(REQUEST_DELAY_MS)
  }
  console.log('\n')

  // 리포트
  console.log(
    `  Naver 라벨: resolved_new ${f.resolved_new} / ambiguous_new ${f.ambiguous_new} / all_existing ${f.all_existing} / negative ${f.negative}`,
  )
  console.log(`  이름토큰 게이트 탈락(같은동네 다른lot): ${f.name_gated}`)
  console.log(`  Kakao 확정: ${f.kakao_confirmed}  /  miss(review) ${f.kakao_miss}`)
  console.log(
    `  dedup 후: 신규 insert ${f.new_insert}  /  기존 충돌(재연결) ${f.existing_collision}`,
  )
  console.log(`  web_sources 승격: ${f.ws_promoted}  /  게이트 탈락 ${f.ws_gated}`)
  if (newSamples.length) console.log(`\n  신규 lot 샘플:\n${newSamples.join('\n')}`)

  const statements = [...lotStmts, ...wsStmts, ...missedStmts]
  const outPath = resolve(import.meta.dir, '..', OUT_SQL)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, statements.join('\n') + '\n', 'utf-8')
  console.log(
    `\n  📄 SQL ${statements.length}문 저장 (lot ${lotStmts.length} / ws ${wsStmts.length} / missed ${missedStmts.length}): ${outPath}`,
  )

  // 검토용 마크다운
  const mdPath = resolve(import.meta.dir, '..', OUT_MD)
  const md: string[] = [
    `# 신규 주차장 등록 후보 검토 — ${todayTag}`,
    '',
    `> resolved_new(Naver) → Kakao 확정(KA-id+좌표) → dedup 통과 **${newLots.length}개**. \`type/총면수/요금\`은 미입력(기본값), 좌표·이름·주소는 Kakao 확정값.`,
    `> 검색어(\`query\`)와 확정 lot명이 다르면 근사 매칭 — 검토 시 주의.`,
    '',
    `| # | 검색어 | 확정 lot명 | type | 주소 | KA-id | 좌표 | 근거행 | 승격 | 인근기존 | 근거 URL |`,
    `|--:|---|---|:--:|---|---|---|:--:|:--:|--:|---|`,
    ...newLots.map(
      (l, i) =>
        `| ${i + 1} | ${l.query} | ${l.name} | ${l.type} | ${l.address} | ${l.lotId} | ${l.lat.toFixed(5)},${l.lng.toFixed(5)} | ${l.rows} | ${l.wsPromoted} | ${l.nearestExistingM ?? '-'}m | ${l.urls.map((u) => `[link](${u})`).join(' ')} |`,
    ),
    '',
  ]
  writeFileSync(mdPath, md.join('\n'), 'utf-8')
  console.log(`  📝 검토 목록 ${newLots.length}개 저장: ${mdPath}`)

  if (APPLY) {
    d1ExecFile(outPath)
    console.log(
      `  ✅ 로컬 적용 완료. remote: bunx wrangler d1 execute parking-db --remote --file=${OUT_SQL}`,
    )
  } else {
    console.log(`  (dry-run — 적용하려면 --apply)`)
  }
  console.log('')
}

main()
