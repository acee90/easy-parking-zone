/**
 * Fixture match-dump 회귀 eval — 현행 매칭 게이트를 AI 정답지와 비교.
 *
 * plan docs/exec-plans/pipeline-149-filter-match-decouple.md §5 의 고정 회귀 루프.
 * lot KA-1935812519(스타필드시티 위례) 수동 크롤 fixture 기준으로
 * searchCandidateLots → isCandidateLocationCompatible → lotNameInFullText →
 * getMatchConfidence 경로를 재현해 precision/recall 측정.
 *
 * 입력(기본 /tmp, --in/--ak/--out 로 override):
 *   --in  fx_answerset_raw.json   : wrangler d1 --json 결과 [{results:[{raw_id,tier,source,title,body}]}]
 *   --ak  fx_answerkey.json       : { "<raw_id>": { expected: "<lot_id>|NONE", ... } }
 *   --out fx_match_eval_rows.json : per-raw 판정 덤프
 *
 * Usage: bun run scripts/eval-match-fixture.ts [--in PATH] [--ak PATH] [--out PATH] [--lot LOT_ID]
 * 로컬 D1 한정 (loadAllLots). remote 미반영.
 */
import { getMatchConfidence, stripHtml } from '../src/server/crawlers/lib/scoring'
import {
  extractSearchKeywords,
  isCandidateLocationCompatible,
  loadAllLots,
  lotNameInFullText,
  searchCandidateLots,
} from './run-pipeline-149'

const argv = process.argv.slice(2)
const arg = (f: string, d: string): string => {
  const i = argv.indexOf(f)
  return i >= 0 ? (argv[i + 1] ?? d) : d
}

const LOT = arg('--lot', 'KA-1935812519')
const IN = arg('--in', '/tmp/fx_answerset_raw.json')
const AK = arg('--ak', '/tmp/fx_answerkey.json')
const OUT = arg('--out', '/tmp/fx_match_eval_rows.json')

const raws = require(IN)[0].results as Array<{
  raw_id: number
  tier: string
  source: string
  title: string
  body: string
}>
const ak = require(AK) as Record<
  string,
  { raw_id: number; expected: string; confidence: string; reason: string }
>

const allLots = loadAllLots()
const ka = allLots.find((l) => l.lot_id === LOT)
if (!ka) throw new Error(`lot ${LOT} not in local parking_lots`)

type Row = {
  raw_id: number
  tier: string
  expected: 'K' | 'NONE'
  predicted: 'K' | 'NONE'
  why: string
  conf: string
}
const rows: Row[] = []

for (const r of raws) {
  const title = stripHtml(r.title)
  const content = stripHtml(r.body || '')
  const fullText = content
  const kws = extractSearchKeywords(title, content)
  const cands = searchCandidateLots(kws, allLots)
  const inCands = cands.some((l) => l.lot_id === LOT)

  let predicted: 'K' | 'NONE' = 'NONE'
  let why = ''
  let conf = '-'
  if (!inCands) {
    why = 'not_in_FTS_candidates'
  } else if (!isCandidateLocationCompatible(kws, ka)) {
    why = `locSkip(kw=[${kws.join(',')}])`
  } else if (fullText.length > 200 && !lotNameInFullText(ka.name, fullText, title)) {
    why = 'preFilter_lotNameNotInFullText'
  } else {
    const { confidence } = getMatchConfidence(title, content, ka.name, ka.address)
    conf = confidence
    predicted = 'K'
    why = `surfaced(conf=${confidence})`
  }

  const expected: 'K' | 'NONE' = ak[r.raw_id]?.expected === LOT ? 'K' : 'NONE'
  rows.push({ raw_id: r.raw_id, tier: r.tier, expected, predicted, why, conf })
}

const TP = rows.filter((x) => x.expected === 'K' && x.predicted === 'K').length
const FN = rows.filter((x) => x.expected === 'K' && x.predicted === 'NONE').length
const FP = rows.filter((x) => x.expected === 'NONE' && x.predicted === 'K').length
const TN = rows.filter((x) => x.expected === 'NONE' && x.predicted === 'NONE').length
const prec = TP / (TP + FP || 1)
const rec = TP / (TP + FN || 1)

console.log(`N=${rows.length}  TP=${TP} FP=${FP} FN=${FN} TN=${TN}`)
console.log(`precision=${prec.toFixed(3)}  recall=${rec.toFixed(3)}`)
console.log('\n--- FN (정답 K인데 게이트가 떨굼 — 매칭 누락) ---')
for (const x of rows.filter((x) => x.expected === 'K' && x.predicted === 'NONE'))
  console.log(`${x.raw_id} [${x.tier}] ${x.why}`)
console.log('\n--- FP (정답 NONE인데 KA로 매칭 — 오염) ---')
for (const x of rows.filter((x) => x.expected === 'NONE' && x.predicted === 'K'))
  console.log(`${x.raw_id} [${x.tier}] ${x.why}`)

require('node:fs').writeFileSync(OUT, JSON.stringify(rows, null, 1))
