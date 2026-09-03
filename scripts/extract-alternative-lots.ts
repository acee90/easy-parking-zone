/**
 * 후기에서 함께 언급된 주차장 추출 배치 (3-1b)
 *
 * web_sources 의 content/ai_summary 에서 다른 주차장 이름을 뽑아 lot_alternatives 에 넣는다.
 *
 * 왜 full_text 가 아니라 content/ai_summary 인가:
 *   web_sources_raw_body.full_text 는 매칭이 끝나면 purge 된다(0단계). 이미 처리된 글의
 *   본문은 남아 있지 않다. 대신 content(최대 1,000자)와 ai_summary(평균 326자)는 남는다.
 *   차이나타운 표본에서는 그 짧은 텍스트에도 "인천내항 8부두"가 등장한다.
 *
 * 사용법:
 *   bun run scripts/extract-alternative-lots.ts --remote --dry-run
 *   bun run scripts/extract-alternative-lots.ts --remote
 *   bun run scripts/extract-alternative-lots.ts --remote --lot 161-2-000155   # 한 곳만
 */
import { unlinkSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { aggregateLotNames, normalizeLotName } from '../src/server/crawlers/lib/alternative-lots'
import { d1ExecFile, d1Query } from './lib/d1'

const DRY_RUN = process.argv.includes('--dry-run')
const lotArgIdx = process.argv.indexOf('--lot')
const ONLY_LOT = lotArgIdx !== -1 ? process.argv[lotArgIdx + 1] : null

/** 이 건수 미만으로 언급된 이름은 버린다. 1건짜리는 우연일 수 있다. */
const MIN_MENTIONS = 2
// ⚠️ is_free_hint 는 "언급 주변 ±20자에 '무료'가 있었다"는 것뿐이다. 무료 여부의 근거가 못 된다.
//    반례: "차이나타운공영주차장은 무료인데 인천내항 8부두는 유료다" → 8부두에 무료 표시가 붙는다.
//    화면의 무료 배지는 **매칭된 lot 의 실제 is_free** 를 쓴다(조회 시 JOIN). 이 값은 참고용으로만 남긴다.
/** 한 주차장에 보여줄 대안 최대 개수 */
const MAX_PER_LOT = 5

interface SourceRow {
  parking_lot_id: string
  content: string | null
  ai_summary: string | null
}

interface LotRow {
  id: string
  name: string
  is_free: number
  lat: number
  lng: number
}

/**
 * 대안으로 인정할 최대 직선거리(km).
 *
 * 이름만으로 매칭하면 전국의 동명 주차장에 연결된다 — 실제로 포천 '산정호수 하동주차장'의
 * 후기가 경남 '하동 공영 주차장'에 걸렸다. 후기에서 "만차면 저기로 갔다"고 말하는 곳은
 * 걸어가거나 잠깐 차로 옮길 수 있는 거리다.
 */
const MAX_ALT_DISTANCE_KM = 3

/** Haversine (km) — geo-utils 와 같은 식이지만 스크립트는 브라우저 모듈을 끌어오지 않는다 */
function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6371
  const dLat = toRad(bLat - aLat)
  const dLng = toRad(bLng - aLng)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h))
}

function esc(v: string): string {
  return v.replace(/'/g, "''")
}

function main() {
  console.log('1) 웹 글 로드')
  const where = ONLY_LOT ? `AND parking_lot_id = '${esc(ONLY_LOT)}'` : ''
  const rows = d1Query<SourceRow>(
    `SELECT parking_lot_id, content, ai_summary
       FROM web_sources
      WHERE relevance_score >= 40
        AND (filter_passed_v2 IS NULL OR filter_passed_v2 != 0)
        ${where}`,
  )
  console.log(`   ${rows.length.toLocaleString()}행`)

  console.log('2) 주차장 이름 사전 구축')
  const lots = d1Query<LotRow>(`SELECT id, name, is_free, lat, lng FROM parking_lots`)
  const byNormalized = new Map<string, LotRow>()
  for (const l of lots) {
    const key = normalizeLotName(l.name)
    // 같은 정규화 이름이 여러 주차장에 걸리면 매칭하지 않는다.
    // 어느 쪽인지 모르는 채로 링크를 걸면 사람을 엉뚱한 곳으로 보낸다.
    if (byNormalized.has(key)) byNormalized.set(key, null as unknown as LotRow)
    else byNormalized.set(key, l)
  }
  const ambiguous = [...byNormalized.values()].filter((v) => !v).length
  console.log(
    `   ${lots.length.toLocaleString()}곳 · 이름 중복으로 매칭 불가 ${ambiguous.toLocaleString()}건`,
  )

  console.log('3) lot 별 추출')
  const grouped = new Map<string, string[]>()
  for (const r of rows) {
    const texts = [r.ai_summary, r.content].filter((t): t is string => Boolean(t?.trim()))
    if (texts.length === 0) continue
    const arr = grouped.get(r.parking_lot_id) ?? []
    // 한 글은 하나의 텍스트로 합쳐 넘긴다 — aggregateLotNames 가 "글 단위 1회"로 세기 때문이다
    arr.push(texts.join('\n'))
    grouped.set(r.parking_lot_id, arr)
  }

  const selfName = new Map(lots.map((l) => [l.id, normalizeLotName(l.name)]))
  const byId = new Map(lots.map((l) => [l.id, l]))
  let tooFar = 0
  const inserts: string[] = []
  const preview: string[] = []
  let lotsWithAlt = 0

  for (const [lotId, texts] of grouped) {
    const candidates = aggregateLotNames(texts)
      // 자기 자신은 대안이 아니다
      .filter((c) => c.normalized !== selfName.get(lotId))
      .filter((c) => c.count >= MIN_MENTIONS)
      .sort((a, b) => b.count - a.count)
      .slice(0, MAX_PER_LOT)

    if (candidates.length === 0) continue

    // 같은 주차장이 여러 이름으로 잡히는 일이 흔하다
    // ("동화마을공영주차장" / "송월동 동화마을 공영주차장"). 매칭된 lot 기준으로 합친다.
    // 안 합치면 카드에 같은 곳이 두 줄로 나온다.
    const merged = new Map<string, (typeof candidates)[number] & { matchedId: string | null }>()
    for (const c of candidates) {
      const hit = byNormalized.get(c.normalized)
      const matchedId = hit ? hit.id : null
      const key = matchedId ?? `~${c.normalized}`
      const prev = merged.get(key)
      if (prev) {
        prev.count += c.count
        prev.isFreeHint = prev.isFreeHint || c.isFreeHint
        // 더 자세한(긴) 표기를 대표 이름으로 남긴다
        if (c.name.length > prev.name.length) prev.name = c.name
      } else {
        merged.set(key, { ...c, matchedId })
      }
    }

    lotsWithAlt++

    for (const c of merged.values()) {
      const matchedId = c.matchedId
      // 우리 DB 와 매칭되지 않은 이름은 저장하지 않는다.
      //
      // 전체 dry-run 에서 708건 중 매칭은 110건(15.5%)이었고, 미매칭 쪽은 이런 것들이었다:
      //   "3개의 대형주차장", "정보없이 네비에 찍힌 선상주차장", "소형 주차장", "본관 지하주차장"
      // 추출기가 문장 조각을 이름으로 만든 결과다. 링크도 못 걸고 사실 확인도 안 되는 문자열을
      // "함께 언급된 주차장"이라고 보여주면 기능이 고장 난 것처럼 읽힌다.
      //
      // 매칭 성공은 그 자체가 검증이다 — 우리 DB 에 같은 이름의 주차장이 실제로 있다는 뜻이다.
      // 재현율을 잃더라도 정밀도를 지킨다.
      if (!matchedId) continue
      // 이름이 같아도 멀면 대안이 아니다
      const self = byId.get(lotId)
      const hit2 = byId.get(matchedId)
      if (self && hit2) {
        const km = distanceKm(self.lat, self.lng, hit2.lat, hit2.lng)
        if (km > MAX_ALT_DISTANCE_KM) {
          tooFar++
          continue
        }
      }
      preview.push(
        `${lotId}  ${c.name.padEnd(30)} 언급 ${String(c.count).padStart(2)}건  ` +
          `매칭 ${matchedId ? byNormalized.get(c.normalized)?.name : '(없음)'}` +
          `${c.isFreeHint ? '  [주변에 무료 언급]' : ''}`,
      )
      inserts.push(
        `INSERT OR REPLACE INTO lot_alternatives
           (parking_lot_id, normalized, display_name, mention_count, is_free_hint, matched_lot_id, updated_at)
         VALUES ('${esc(lotId)}','${esc(c.normalized)}','${esc(c.name)}',${c.count},${c.isFreeHint ? 1 : 0},${
           matchedId ? `'${esc(matchedId)}'` : 'NULL'
         },datetime('now'));`,
      )
    }
  }

  console.log(
    `   대안이 잡힌 lot ${lotsWithAlt.toLocaleString()}곳 · 저장 대상 ${inserts.length.toLocaleString()}건 ` +
      `(매칭된 것만 · ${MAX_ALT_DISTANCE_KM}km 초과로 뺀 것 ${tooFar.toLocaleString()}건)`,
  )

  if (DRY_RUN) {
    console.log('\n[dry-run] 예시 20건:')
    for (const line of preview.slice(0, 20)) console.log('  ', line)
    console.log(`\n실제 변경 없음. ${inserts.length.toLocaleString()}건을 넣을 예정.`)
    return
  }

  console.log('4) 적재')
  const file = resolve(process.cwd(), '.tmp-lot-alternatives.sql')
  const CHUNK = 300
  for (let i = 0; i < inserts.length; i += CHUNK) {
    writeFileSync(file, inserts.slice(i, i + CHUNK).join('\n'))
    d1ExecFile(file)
    console.log(
      `   ${Math.min(i + CHUNK, inserts.length).toLocaleString()} / ${inserts.length.toLocaleString()}`,
    )
  }
  try {
    unlinkSync(file)
  } catch {}
  console.log('완료')
}

try {
  main()
} catch (e) {
  console.error(e)
  process.exit(1)
}
