/**
 * lot-match 좌표회수 eval — 이름매칭(baseline) vs 좌표회수(place-search) 비교
 *
 * 계획: docs/exec-plans/missed-web-sources-new-parking-lots.plan.md
 *
 * web_sources_missed를 resolution_status로 stratified 샘플 →
 *  - baseline: 현행 production 매처 pickBestLot (이름/FTS 기반, 좌표 미사용)
 *  - recovery: Naver 장소검색 + 좌표 dedup (lib/place-match.resolvePlace)
 * 두 결과를 비교해 좌표회수의 recall 회수율과 precision(신규/노이즈 오매칭)을 측정.
 *
 * 주의: resolution_status는 resolve-missed가 place-match로 만든 silver 라벨이라
 * recovery와의 일치는 부분적으로 동어반복적. 핵심 측정은 (1) baseline이 놓친 것 중
 * 좌표회수가 기존 lot으로 회수하는 비율, (2) 신규/노이즈를 기존 lot으로 잘못 붙이는 비율.
 *
 * Usage:
 *   bun run scripts/eval-lot-match-recovery.ts                 # 기본 stratified 샘플
 *   bun run scripts/eval-lot-match-recovery.ts --per 50        # stratum당 N개
 *
 * 환경변수: NAVER_CLIENT_ID, NAVER_CLIENT_SECRET (로컬 D1)
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, resolve } from 'path'
import { d1Query } from './lib/d1'
import { normalizeName } from './lib/missed-classify'
import { searchNaverLocal } from './lib/naver-api'
import { extractHints, loadExistingLots, resolvePlace } from './lib/place-match'
import { pickBestLot } from './run-pipeline-149'

const args = process.argv.slice(2)
const perIdx = args.indexOf('--per')
const PER = perIdx >= 0 ? parseInt(args[perIdx + 1], 10) : 40
const DUMP = args.includes('--dump') // 샘플만 추출(검색 안 함) → 서브에이전트 AI 이름추출 입력
const aiIdx = args.indexOf('--ai-names')
const AI_NAMES_FILE = aiIdx >= 0 ? args[aiIdx + 1] : null
const DEDUP_RADIUS_M = 60
const REQUEST_DELAY_MS = 150
const todayTag = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const OUT = AI_NAMES_FILE
  ? `data/eval-lot-match-sample-ai-${todayTag}.json`
  : `data/eval-lot-match-sample-${todayTag}.json`
const DUMP_OUT = `data/eval-lot-match-input-${todayTag}.json`

// AI 이름추출 결과 로드 (missed_lot_name → 정제된 검색명; '' = lot명 없음)
const aiNames: Map<string, string> = AI_NAMES_FILE
  ? new Map(
      (
        JSON.parse(readFileSync(resolve(import.meta.dir, '..', AI_NAMES_FILE), 'utf-8')) as {
          missed_lot_name: string
          ai_name: string
        }[]
      ).map((r) => [r.missed_lot_name, r.ai_name]),
    )
  : new Map()

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const PARKING_RE = /(주차장|파킹|parking)/i
const buildQuery = (name: string) => (PARKING_RE.test(name) ? name : `${name} 주차장`)

interface SampleRow {
  missed_lot_name: string
  title: string
  content: string
  resolution_status: string | null
  resolved_parking_lot_id: string | null
}

// resolution_status별 stratified 샘플 (후보=missed_lot_name 단위, 대표 1행)
function sample(status: string | null, n: number): SampleRow[] {
  const cond = status === null ? 'resolution_status IS NULL' : `resolution_status = '${status}'`
  return d1Query<SampleRow>(
    `SELECT missed_lot_name,
            MAX(title) AS title,
            MAX(content) AS content,
            resolution_status,
            MAX(resolved_parking_lot_id) AS resolved_parking_lot_id
     FROM web_sources_missed
     WHERE ${cond}
     GROUP BY missed_lot_name
     ORDER BY COUNT(*) DESC
     LIMIT ${n}`,
  )
}

interface EvalRow {
  missed_lot_name: string
  stratum: string
  silver_lot_id: string | null
  baseline: string // matched lot_id | 'NONE'
  recovery_label: string
  recovery_lot_id: string | null
}

async function main() {
  const strata: (string | null)[] = [
    'resolved_existing_lot',
    null, // resolved_new / org 보류
    'rejected_no_place',
    'rejected_noise',
    'review_required',
  ]

  // 결정적 stratified 샘플 수집 (dump/eval 동일)
  const allSamples: { s: SampleRow; stratum: string; name: string }[] = []
  for (const status of strata) {
    for (const s of sample(status, PER)) {
      const name = normalizeName(s.missed_lot_name)
      if (name) allSamples.push({ s, stratum: status ?? 'null_active', name })
    }
  }

  // --dump: 검색 없이 샘플(title/content 포함)만 출력 → 서브에이전트 AI 이름추출 입력
  if (DUMP) {
    const dumpPath = resolve(import.meta.dir, '..', DUMP_OUT)
    mkdirSync(dirname(dumpPath), { recursive: true })
    writeFileSync(
      dumpPath,
      JSON.stringify(
        allSamples.map(({ s, stratum, name }) => ({
          missed_lot_name: name,
          stratum,
          silver_lot_id: s.resolved_parking_lot_id,
          title: s.title,
          content: (s.content ?? '').slice(0, 600),
        })),
        null,
        2,
      ),
      'utf-8',
    )
    console.log(`\n📤 샘플 ${allSamples.length}건 dump (AI 이름추출 입력): ${dumpPath}\n`)
    return
  }

  const lots = loadExistingLots()
  const mode = AI_NAMES_FILE ? `AI-이름(${aiNames.size}개)` : '키워드-이름'
  console.log(
    `\n🧪 lot-match 좌표회수 eval — ${mode} (stratum당 ${PER}개, dedup=${DEDUP_RADIUS_M}m)`,
  )
  console.log(`  기존 parking_lots ${lots.length.toLocaleString()}개\n`)

  const rows: EvalRow[] = []
  for (const { s, stratum: stratumName, name } of allSamples) {
    // baseline: 현행 이름기반 매처 (AI 모드와 무관하게 동일)
    const b = pickBestLot(s.title, s.content, s.content)
    const baseline = b ? b.lot.lot_id : 'NONE'

    // recovery 검색명: AI 모드면 추출명 사용('' = lot명 없음 → 검색 스킵)
    const queryName = AI_NAMES_FILE ? (aiNames.get(name) ?? name) : name
    let recoveryLabel = 'negative'
    let recoveryLot: string | null = null
    if (AI_NAMES_FILE && queryName.trim() === '') {
      recoveryLabel = 'no_name' // AI가 lot명 없음으로 판정 → 검색 안 함
    } else {
      try {
        const items = await searchNaverLocal(buildQuery(queryName), 5)
        const hints = extractHints(`${s.title} ${s.content}`)
        const o = resolvePlace(queryName, items, lots, hints, DEDUP_RADIUS_M)
        recoveryLabel = o.label
        recoveryLot = o.label === 'all_existing' ? (o.best?.existing_lot_id ?? null) : null
      } catch (e) {
        recoveryLabel = `error:${e instanceof Error ? e.message.slice(0, 20) : ''}`
      }
      await sleep(REQUEST_DELAY_MS)
    }
    rows.push({
      missed_lot_name: name,
      stratum: stratumName,
      silver_lot_id: s.resolved_parking_lot_id,
      baseline,
      recovery_label: recoveryLabel,
      recovery_lot_id: recoveryLot,
    })
  }

  // ── 리포트 ──
  const byStratum = new Map<string, EvalRow[]>()
  for (const r of rows) {
    if (!byStratum.has(r.stratum)) byStratum.set(r.stratum, [])
    byStratum.get(r.stratum)!.push(r)
  }

  console.log(`\n  === stratum별 결과 (N=${rows.length}) ===`)
  for (const [stratum, rs] of byStratum) {
    const baselineMatched = rs.filter((r) => r.baseline !== 'NONE').length
    const recExisting = rs.filter((r) => r.recovery_label === 'all_existing').length
    const recNew = rs.filter((r) => r.recovery_label === 'resolved_new').length
    const recAmb = rs.filter((r) => r.recovery_label === 'ambiguous_new').length
    const recNeg = rs.filter((r) => r.recovery_label === 'negative').length
    console.log(`\n  [${stratum}] N=${rs.length}`)
    console.log(`    baseline 매칭: ${baselineMatched}`)
    console.log(
      `    recovery: existing ${recExisting} / new ${recNew} / ambiguous ${recAmb} / negative ${recNeg}`,
    )
    if (stratum === 'resolved_existing_lot') {
      const sameLot = rs.filter(
        (r) => r.recovery_label === 'all_existing' && r.recovery_lot_id === r.silver_lot_id,
      ).length
      const baselineSame = rs.filter((r) => r.baseline === r.silver_lot_id).length
      console.log(`    ▶ 좌표회수가 silver와 동일 lot 회수: ${sameLot}/${rs.length}`)
      console.log(
        `    ▶ baseline이 동일 lot 매칭: ${baselineSame}/${rs.length} (회수 lift = ${sameLot - baselineSame})`,
      )
    }
    if (
      stratum === 'null_active' ||
      stratum === 'rejected_no_place' ||
      stratum === 'rejected_noise'
    ) {
      console.log(`    ▶ (precision 위험) 신규/노이즈인데 기존 lot으로 회수: ${recExisting}`)
    }
  }

  const outPath = resolve(import.meta.dir, '..', OUT)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(
    outPath,
    JSON.stringify({ generated_at: new Date().toISOString(), rows }, null, 2),
    'utf-8',
  )
  console.log(`\n  ✅ 샘플 ${rows.length}건 저장(수동 검수용): ${outPath}\n`)
}

main()
