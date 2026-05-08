/**
 * #149 파이프라인 eval — rule filter / AI filter / match 스테이지별 품질 측정
 *
 * Usage:
 *   bun run scripts/eval-pipeline-149.ts          # 데이터 수집 + rule/match eval (로컬 DB)
 *   bun run scripts/eval-pipeline-149.ts --report # AI 결과 머지 후 최종 리포트
 *
 * AI filter eval (Stage 2):
 *   /eval-pipeline-149 명령어를 실행하면 haiku subagent가 자동으로 처리함.
 *   직접 실행 시:
 *     1. bun run scripts/eval-pipeline-149.ts  → /tmp/eval-149-medium.json 생성
 *     2. haiku subagent → /tmp/eval-149-ai-results.json 생성
 *     3. bun run scripts/eval-pipeline-149.ts --report  → 최종 리포트
 *
 * 중간 파일:
 *   - /tmp/eval-149-collect.json : 수집된 샘플 + rule/match 결과 (첫 실행 시 생성)
 *   - /tmp/eval-149-medium.json  : AI eval용 medium tier 샘플
 *   - /tmp/eval-149-ai-results.json : haiku subagent 결과 (외부 생성)
 *   - /tmp/eval-149-results.json : 건별 상세 결과
 *   - /tmp/eval-149-report.md    : 최종 평가 리포트
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { classifyByRule } from '../src/server/crawlers/lib/rule-filter'
import { d1Query } from './lib/d1'

const isReport = process.argv.includes('--report')

// ── 타입 정의 ──────────────────────────────────────────────

interface FilterSample {
  id: number
  source: string
  title: string
  full_text: string
  filter_passed_v2: number | null
  filter_v2_reason: string | null
  lot_name: string
}

interface MatchSample {
  raw_id: number
  title: string
  content: string
  lot_name: string
  matched: boolean
}

interface RuleResult {
  id: number
  tier: 'high' | 'medium' | 'low'
  ground_truth: number | null
  v2_reason: string | null
  correct: boolean | null
}

interface RuleStats {
  highCount: number
  mediumCount: number
  lowCount: number
  highPrecision: number | null
  lowPrecision: number | null
  falseNeg: number
  mediumRatio: number
}

interface MatchStats {
  nameMatchRate: number
  nameInTitleCount: number
  nameInContentCount: number
  matchedCount: number
  unmatchedTitles: string[]
}

interface CollectData {
  positives: FilterSample[]
  negatives: FilterSample[]
  matched: MatchSample[]
  unmatched: MatchSample[]
  posResults: RuleResult[]
  negResults: RuleResult[]
  rulePos: RuleStats
  ruleNeg: RuleStats
  matchStats: MatchStats
  mediumSamples: FilterSample[]
}

interface AiResultItem {
  id: number
  filterPassed: boolean
  filterRemovedBy: string | null
  sentimentScore: number | null
}

interface AiStats {
  accuracy: number
  precision: number | null
  recall: number | null
  removedByDist: Record<string, number>
  sampleCount: number
}

// ── 데이터 수집 ────────────────────────────────────────────

function fetchFilterSamples(): { positives: FilterSample[]; negatives: FilterSample[] } {
  console.log('📥 filter 샘플 수집 중...')

  const positives = d1Query<FilterSample>(`
    SELECT ws.id, ws.source, ws.title,
           SUBSTR(ws.full_text, 1, 2000) as full_text,
           ws.filter_passed_v2, ws.filter_v2_reason,
           pl.name as lot_name
    FROM web_sources ws
    JOIN parking_lots pl ON pl.id = ws.parking_lot_id
    WHERE ws.full_text_status = 'ok'
      AND ws.filter_passed_v2 = 1
    ORDER BY RANDOM()
    LIMIT 1000
  `)

  const negatives = d1Query<FilterSample>(`
    SELECT ws.id, ws.source, ws.title,
           SUBSTR(ws.full_text, 1, 2000) as full_text,
           ws.filter_passed_v2, ws.filter_v2_reason,
           pl.name as lot_name
    FROM web_sources ws
    JOIN parking_lots pl ON pl.id = ws.parking_lot_id
    WHERE ws.full_text_status = 'ok'
      AND ws.filter_passed_v2 = 0
    ORDER BY RANDOM()
    LIMIT 1000
  `)

  console.log(`  PASS 샘플: ${positives.length}건, FAIL 샘플: ${negatives.length}건`)
  return { positives, negatives }
}

function fetchMatchSamples(): { matched: MatchSample[]; unmatched: MatchSample[] } | null {
  console.log('📥 match 샘플 수집 중...')

  try {
    d1Query('SELECT 1 FROM web_sources_raw LIMIT 1')
  } catch {
    console.log('  web_sources_raw 없음 — match eval 스킵 (로컬 DB)')
    return null
  }

  const matched = d1Query<MatchSample>(`
    SELECT r.id as raw_id, r.title, r.content,
           pl.name as lot_name,
           1 as matched
    FROM web_sources_raw r
    JOIN web_sources ws ON ws.raw_source_id = r.id
    JOIN parking_lots pl ON pl.id = ws.parking_lot_id
    WHERE r.filter_passed = 1 AND r.matched_at IS NOT NULL
    GROUP BY r.id
    ORDER BY RANDOM()
    LIMIT 30
  `)

  const unmatched = d1Query<MatchSample>(`
    SELECT r.id as raw_id, r.title, r.content,
           '' as lot_name,
           0 as matched
    FROM web_sources_raw r
    WHERE r.filter_passed = 1
      AND r.matched_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM web_sources ws WHERE ws.raw_source_id = r.id)
    ORDER BY RANDOM()
    LIMIT 30
  `)

  console.log(`  매칭 성공: ${matched.length}건, 매칭 실패: ${unmatched.length}건`)
  return { matched, unmatched }
}

// ── Stage 1: Rule Filter Eval ──────────────────────────────

function evalRuleFilter(samples: FilterSample[]): RuleResult[] {
  return samples.map((s) => {
    const tier = classifyByRule({
      fullText: s.full_text,
      fullTextStatus: 'ok',
      title: s.title,
    })
    let correct: boolean | null = null
    if (tier === 'high') correct = s.filter_passed_v2 === 1
    else if (tier === 'low') correct = s.filter_passed_v2 === 0
    return {
      id: s.id,
      tier,
      ground_truth: s.filter_passed_v2,
      v2_reason: s.filter_v2_reason,
      correct,
    }
  })
}

function computeRuleStats(results: RuleResult[]): RuleStats {
  const high = results.filter((r) => r.tier === 'high')
  const low = results.filter((r) => r.tier === 'low')
  const medium = results.filter((r) => r.tier === 'medium')
  return {
    highCount: high.length,
    mediumCount: medium.length,
    lowCount: low.length,
    highPrecision:
      high.length > 0 ? high.filter((r) => r.correct === true).length / high.length : null,
    lowPrecision: low.length > 0 ? low.filter((r) => r.correct === true).length / low.length : null,
    falseNeg: results.filter((r) => r.ground_truth === 1 && r.tier === 'low').length,
    mediumRatio: results.length > 0 ? medium.length / results.length : 0,
  }
}

function printRuleStats(stats: RuleStats, label: string) {
  console.log(`\n[Rule Filter — ${label}]`)
  console.log(
    `  high: ${stats.highCount}건 | precision: ${stats.highPrecision !== null ? pct(stats.highPrecision) : 'n/a'}`,
  )
  console.log(
    `  low:  ${stats.lowCount}건 | precision: ${stats.lowPrecision !== null ? pct(stats.lowPrecision) : 'n/a'}`,
  )
  console.log(`  medium: ${stats.mediumCount}건 (${pct(stats.mediumRatio)})`)
  console.log(`  false negative (PASS→low): ${stats.falseNeg}건`)
}

// ── Stage 2: AI Filter Stats ───────────────────────────────

function computeAiStats(aiResults: AiResultItem[], mediumSamples: FilterSample[]): AiStats {
  const groundTruthMap = new Map(mediumSamples.map((s) => [s.id, s.filter_passed_v2]))

  let correct = 0
  let truePos = 0
  let gtPassCount = 0
  const removedByDist: Record<string, number> = {}

  const matched = aiResults.filter((r) => groundTruthMap.has(r.id))

  for (const r of matched) {
    const gt = groundTruthMap.get(r.id)!
    if ((r.filterPassed ? 1 : 0) === gt) correct++
    if (r.filterPassed && gt === 1) truePos++
    if (gt === 1) gtPassCount++
    if (!r.filterPassed) {
      const key = r.filterRemovedBy ?? 'unknown'
      removedByDist[key] = (removedByDist[key] ?? 0) + 1
    }
  }

  const aiPassCount = matched.filter((r) => r.filterPassed).length
  return {
    accuracy: matched.length > 0 ? correct / matched.length : 0,
    precision: aiPassCount > 0 ? truePos / aiPassCount : null,
    recall: gtPassCount > 0 ? truePos / gtPassCount : null,
    removedByDist,
    sampleCount: matched.length,
  }
}

// ── Stage 3: Match Eval ────────────────────────────────────

/**
 * lot_name에서 검색 키워드 추출.
 * "○○공영주차장" → ["○○"] 형태의 의미 있는 핵심어를 뽑는다.
 *
 * 전략:
 * 1. 주차장 유형 접미사 제거 (공영/민영/노외/노상/부설/제N)
 * 2. 남은 이름이 2자 이상이면 그걸 키워드로 사용
 * 3. 길이 4자 이상이면 앞 4자 substring도 추가 (부분 일치 허용)
 */
function extractLotKeywords(lotName: string): string[] {
  const stripped = lotName
    .replace(/\s*(?:공영|민영|노외|노상|부설|임시|제\d+)?\s*주차장\s*$/, '')
    .trim()
  const keywords: string[] = []
  if (stripped.length >= 2) {
    keywords.push(stripped)
    if (stripped.length >= 4) keywords.push(stripped.slice(0, 4))
  } else {
    // 너무 짧으면 원본 이름 앞 4자 사용
    keywords.push(lotName.replace(/\s/g, '').slice(0, 4))
  }
  return [...new Set(keywords.filter((k) => k.length >= 2))]
}

function evalMatch(matched: MatchSample[], unmatched: MatchSample[]): MatchStats {
  console.log('\n[Match Eval — 성공]')

  const details = matched.map((m) => {
    const keywords = extractLotKeywords(m.lot_name)
    const lowerTitle = m.title.toLowerCase()
    const lowerContent = m.content.toLowerCase()
    const inTitle = keywords.some((kw) => lowerTitle.includes(kw.toLowerCase()))
    const inContent = keywords.some((kw) => lowerContent.includes(kw.toLowerCase()))
    return { inTitle, inContent, keywords }
  })

  const nameMatchRate =
    matched.length > 0 ? details.filter((d) => d.inTitle || d.inContent).length / matched.length : 0

  console.log(`  lot name in title: ${details.filter((d) => d.inTitle).length}/${matched.length}`)
  console.log(
    `  lot name in content: ${details.filter((d) => d.inContent).length}/${matched.length}`,
  )
  console.log(`  name match rate (title OR content): ${pct(nameMatchRate)}`)

  console.log('\n[Match Eval — 실패] (수동 분류용)')
  for (const u of unmatched) console.log(`  [${u.raw_id}] ${u.title.slice(0, 60)}`)

  return {
    nameMatchRate,
    nameInTitleCount: details.filter((d) => d.inTitle).length,
    nameInContentCount: details.filter((d) => d.inContent).length,
    matchedCount: matched.length,
    unmatchedTitles: unmatched.map((u) => u.title.slice(0, 60)),
  }
}

// ── 리포트 생성 ────────────────────────────────────────────

function pct(n: number) {
  return `${(n * 100).toFixed(1)}%`
}

function writeReport(data: CollectData, aiStats: AiStats | null) {
  const { rulePos, ruleNeg, posResults, negResults, matchStats } = data
  const allResults = [...posResults, ...negResults]

  const totalMedium = rulePos.mediumCount + ruleNeg.mediumCount
  const mediumRatio = allResults.length > 0 ? totalMedium / allResults.length : 0
  const gtPassCount = allResults.filter((r) => r.ground_truth === 1).length
  const totalFalseNeg = (rulePos.falseNeg ?? 0) + (ruleNeg.falseNeg ?? 0)
  const falseNegRate = gtPassCount > 0 ? totalFalseNeg / gtPassCount : 0

  const md = `# Eval 결과: #149 파이프라인

> 실행: ${new Date().toISOString()}

## Stage 1 — Rule Filter

| 구분 | high | medium | low | high precision | false negative |
|------|------|--------|-----|----------------|----------------|
| PASS 샘플(15) | ${rulePos.highCount} | ${rulePos.mediumCount} | ${rulePos.lowCount} | ${rulePos.highPrecision !== null ? pct(rulePos.highPrecision) : '-'} | ${rulePos.falseNeg} |
| FAIL 샘플(15) | ${ruleNeg.highCount} | ${ruleNeg.mediumCount} | ${ruleNeg.lowCount} | ${ruleNeg.highPrecision !== null ? pct(ruleNeg.highPrecision) : '-'} | ${ruleNeg.falseNeg} |

**Medium ratio (전체)**: ${pct(mediumRatio)} (목표 ≤ 50%)
**False negative rate**: ${pct(falseNegRate)} (목표 ≤ 10%)

## Stage 2 — AI Filter (medium tier)

${
  aiStats
    ? `| 지표 | 값 | 목표 | 합격 |
|------|-----|------|------|
| Accuracy | ${pct(aiStats.accuracy)} | ≥ 85% | ${aiStats.accuracy >= 0.85 ? '✅' : '❌'} |
| Precision | ${aiStats.precision !== null ? pct(aiStats.precision) : '-'} | ≥ 80% | ${aiStats.precision !== null ? (aiStats.precision >= 0.8 ? '✅' : '❌') : '-'} |
| Recall | ${aiStats.recall !== null ? pct(aiStats.recall) : '-'} | ≥ 75% | ${aiStats.recall !== null ? (aiStats.recall >= 0.75 ? '✅' : '❌') : '-'} |

removed_by 분포: ${JSON.stringify(aiStats.removedByDist)}
샘플 수: ${aiStats.sampleCount}건`
    : '⏳ AI 결과 대기 중 — /eval-pipeline-149 명령어로 haiku subagent 실행 필요\n(/tmp/eval-149-ai-results.json 생성 후 --report 플래그로 재실행)'
}

## Stage 3 — Match

| 지표 | 값 | 목표 | 합격 |
|------|-----|------|------|
| Name match rate | ${pct(matchStats.nameMatchRate)} | ≥ 70% | ${matchStats.nameMatchRate >= 0.7 ? '✅' : '❌'} |

매칭 실패 샘플 (수동 원인 분류 필요):
${matchStats.unmatchedTitles.map((t) => `- ${t}`).join('\n')}

## 종합 판정

- Rule high precision: ${rulePos.highPrecision !== null ? `${pct(rulePos.highPrecision)} ${rulePos.highPrecision >= 0.9 ? '✅' : '❌ (목표 ≥ 90%)'}` : '샘플 없음'}
- Medium ratio: ${pct(mediumRatio)} ${mediumRatio <= 0.5 ? '✅' : '❌ (목표 ≤ 50%)'}
- False negative rate: ${pct(falseNegRate)} ${falseNegRate <= 0.1 ? '✅' : '❌ (목표 ≤ 10%)'}
${
  aiStats
    ? `- AI accuracy: ${pct(aiStats.accuracy)} ${aiStats.accuracy >= 0.85 ? '✅' : '❌ (목표 ≥ 85%)'}`
    : '- AI accuracy: 미평가'
}
- Match name rate: ${pct(matchStats.nameMatchRate)} ${matchStats.nameMatchRate >= 0.7 ? '✅' : '❌ (목표 ≥ 70%)'}
`

  writeFileSync('/tmp/eval-149-report.md', md)
  return { mediumRatio, falseNegRate }
}

// ── main ──────────────────────────────────────────────────

async function main() {
  console.log('=== #149 파이프라인 Eval ===\n')

  let collectData: CollectData

  if (isReport && existsSync('/tmp/eval-149-collect.json')) {
    // --report 모드: 저장된 수집 데이터 재사용 (샘플 일관성 유지)
    console.log('📂 저장된 수집 데이터 로딩: /tmp/eval-149-collect.json')
    collectData = JSON.parse(readFileSync('/tmp/eval-149-collect.json', 'utf-8')) as CollectData
    console.log(
      `  PASS 샘플: ${collectData.positives.length}건, FAIL 샘플: ${collectData.negatives.length}건`,
    )
    console.log(
      `  매칭 성공: ${collectData.matched.length}건, 매칭 실패: ${collectData.unmatched.length}건`,
    )
  } else {
    // 수집 모드: DB에서 새로 샘플링
    const { positives, negatives } = fetchFilterSamples()
    const matchResult = fetchMatchSamples()

    console.log('\n── Stage 1: Rule Filter ──')
    const posResults = evalRuleFilter(positives)
    const negResults = evalRuleFilter(negatives)
    const rulePos = computeRuleStats(posResults)
    const ruleNeg = computeRuleStats(negResults)
    printRuleStats(rulePos, `PASS 샘플(${positives.length})`)
    printRuleStats(ruleNeg, `FAIL 샘플(${negatives.length})`)

    const matched = matchResult?.matched ?? []
    const unmatched = matchResult?.unmatched ?? []
    console.log('\n── Stage 3: Match ──')
    const matchStats = evalMatch(matched, unmatched)

    const mediumSamples = [
      ...positives.filter((_, i) => posResults[i].tier === 'medium'),
      ...negatives.filter((_, i) => negResults[i].tier === 'medium'),
    ]

    collectData = {
      positives,
      negatives,
      matched,
      unmatched,
      posResults,
      negResults,
      rulePos,
      ruleNeg,
      matchStats,
      mediumSamples,
    }

    // 수집 데이터 저장 (--report 모드에서 재사용)
    writeFileSync('/tmp/eval-149-collect.json', JSON.stringify(collectData, null, 2))

    // medium 샘플 저장 (haiku subagent용)
    const mediumForAi = mediumSamples.map((s) => ({
      id: s.id,
      title: s.title,
      full_text: s.full_text ?? '',
      lot_name: s.lot_name,
      ground_truth: s.filter_passed_v2,
    }))
    writeFileSync('/tmp/eval-149-medium.json', JSON.stringify(mediumForAi, null, 2))
    console.log(`\n  → medium 샘플 저장: /tmp/eval-149-medium.json (${mediumSamples.length}건)`)
    console.log('  💡 AI filter eval: /eval-pipeline-149 명령어로 haiku subagent 실행')
    console.log('     또는: haiku subagent → /tmp/eval-149-ai-results.json → --report 재실행')
  }

  // Stage 2: AI filter stats
  console.log('\n── Stage 2: AI Filter ──')
  let aiStats: AiStats | null = null
  if (existsSync('/tmp/eval-149-ai-results.json')) {
    try {
      const raw = JSON.parse(readFileSync('/tmp/eval-149-ai-results.json', 'utf-8')) as {
        results: AiResultItem[]
      }
      aiStats = computeAiStats(raw.results, collectData.mediumSamples)
      console.log(`  accuracy: ${pct(aiStats.accuracy)} (${aiStats.sampleCount}건)`)
      console.log(
        `  precision: ${aiStats.precision !== null ? pct(aiStats.precision) : 'n/a'}, recall: ${aiStats.recall !== null ? pct(aiStats.recall) : 'n/a'}`,
      )
      console.log(`  removed_by: ${JSON.stringify(aiStats.removedByDist)}`)
    } catch (e) {
      console.error(`  AI 결과 파싱 오류: ${(e as Error).message}`)
    }
  } else {
    console.log('  ⏳ /tmp/eval-149-ai-results.json 없음 — AI eval 스킵')
  }

  // 리포트 저장
  const stats = writeReport(collectData, aiStats)
  writeFileSync('/tmp/eval-149-results.json', JSON.stringify({ ...collectData, aiStats }, null, 2))

  console.log('\n📄 결과 저장:')
  console.log('  /tmp/eval-149-collect.json (수집 데이터)')
  console.log('  /tmp/eval-149-medium.json (medium 샘플)')
  console.log('  /tmp/eval-149-results.json')
  console.log('  /tmp/eval-149-report.md')

  console.log('\n=== 종합 판정 ===')
  console.log(`  Medium ratio: ${pct(stats.mediumRatio)} ${stats.mediumRatio <= 0.5 ? '✅' : '❌'}`)
  console.log(
    `  False negative rate: ${pct(stats.falseNegRate)} ${stats.falseNegRate <= 0.1 ? '✅' : '❌'}`,
  )
  if (collectData.rulePos.highPrecision !== null)
    console.log(
      `  High precision: ${pct(collectData.rulePos.highPrecision)} ${collectData.rulePos.highPrecision >= 0.9 ? '✅' : '❌'}`,
    )
  if (aiStats)
    console.log(`  AI accuracy: ${pct(aiStats.accuracy)} ${aiStats.accuracy >= 0.85 ? '✅' : '❌'}`)
  console.log(
    `  Name match rate: ${pct(collectData.matchStats.nameMatchRate)} ${collectData.matchStats.nameMatchRate >= 0.7 ? '✅' : '❌'}`,
  )
}

main().catch((e) => {
  console.error('eval 실패:', e)
  process.exit(1)
})
