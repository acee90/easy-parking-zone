/**
 * 주차장 통합 난이도 점수 배치 계산
 *
 * 알고리즘 문서 §4.1~4.5 구현.
 * parking_lot_stats 테이블에 베이지안 통합 점수를 사전 계산하여 저장.
 *
 * Usage:
 *   bun run scripts/compute-parking-stats.ts [--remote] [--dry-run] [--dry-stats]
 *
 * --dry-run:   DB 업데이트 없이 결과를 JSON 파일로 저장
 * --dry-stats: DB 업데이트 없이 분포 + 큐레이션 일관성만 콘솔 출력 (sweep용)
 */

import { writeFileSync } from 'fs'
import { join } from 'path'
import {
  applyCurationCap,
  computeFinalScore,
  computeSourceScores,
  computeStructuralPrior,
  type ReviewSignal,
  SCORE_PARAMS,
  type WebSignal,
} from '../src/server/crawlers/lib/scoring-engine-core'
import { d1Query, isRemote } from './lib/d1'

const isDryRun = process.argv.includes('--dry-run')
const isDryStats = process.argv.includes('--dry-stats')
const BATCH_SIZE = 1000

interface ParkingLot {
  id: string
  name: string
  type: string | null
  total_spaces: number | null
  is_free: number | null
  notes: string | null
  curation_tag: string | null
}

interface ReviewRow extends ReviewSignal {
  parking_lot_id: string
}

interface TextRow extends WebSignal {
  parking_lot_id: string
  source: string
  match_type: 'direct' | 'ai_high' | 'ai_medium'
}

interface StatsRow {
  parkingLotId: string
  parkingLotName: string
  curationTag: string | null
  structuralPrior: number
  reviewScore: number | null
  reviewCount: number
  webScore: number | null
  webCount: number
  nEffective: number
  finalScore: number
  reliability: string
}

// ---------------------------------------------------------------------------
// 4. 메인 배치 처리
// ---------------------------------------------------------------------------

async function main() {
  console.log(
    `[Stats] ${isRemote ? 'REMOTE' : 'LOCAL'} D1 | ${isDryRun ? 'DRY-RUN' : isDryStats ? 'DRY-STATS' : 'LIVE'}`,
  )
  if (isDryStats) {
    console.log('[Stats] PARAMS:', JSON.stringify(SCORE_PARAMS, null, 2))
  }

  const now = new Date()

  // 전체 주차장 수
  const totalResult = d1Query<{ cnt: number }>('SELECT COUNT(*) as cnt FROM parking_lots')
  const totalLots = totalResult[0]?.cnt ?? 0
  console.log(`[Stats] 전체 주차장: ${totalLots}개`)

  // 전체 리뷰 로드 (parking_lot_id별 그룹핑용)
  console.log('[Stats] 리뷰 로드 중...')
  const allReviews = d1Query<ReviewRow>(
    'SELECT parking_lot_id, overall_score, is_seed, source_type, created_at FROM user_reviews',
  )
  const reviewsByLot = new Map<string, ReviewRow[]>()
  for (const r of allReviews) {
    if (!reviewsByLot.has(r.parking_lot_id)) reviewsByLot.set(r.parking_lot_id, [])
    reviewsByLot.get(r.parking_lot_id)!.push(r)
  }
  console.log(`[Stats] 리뷰 ${allReviews.length}건 (${reviewsByLot.size}개 주차장)`)

  // 전체 텍스트 감성 로드 (직접 매칭 + ai_matches UNION)
  console.log('[Stats] 텍스트 감성 로드 중...')
  const allTexts = d1Query<TextRow>(
    `SELECT ws.parking_lot_id, ws.sentiment_score, ws.relevance_score, ws.source, ws.published_at, 'direct' as match_type
     FROM web_sources ws
     WHERE ws.parking_lot_id IS NOT NULL
       AND ws.sentiment_score IS NOT NULL
       AND ws.relevance_score > 30
       AND ws.filter_passed_v2 = 1
     UNION ALL
     SELECT am.parking_lot_id, ws.sentiment_score, ws.relevance_score, ws.source, ws.published_at,
       CASE am.confidence WHEN 'high' THEN 'ai_high' ELSE 'ai_medium' END as match_type
     FROM web_source_ai_matches am
     JOIN web_sources ws ON ws.id = am.web_source_id
     WHERE 1=1
       AND ws.sentiment_score IS NOT NULL
       AND ws.relevance_score > 30
       AND ws.filter_passed_v2 = 1
       AND am.confidence IN ('high', 'medium')
       AND (ws.parking_lot_id IS NULL OR am.parking_lot_id != ws.parking_lot_id)`,
  )
  const textsByLot = new Map<string, TextRow[]>()
  for (const t of allTexts) {
    if (!textsByLot.has(t.parking_lot_id)) textsByLot.set(t.parking_lot_id, [])
    textsByLot.get(t.parking_lot_id)!.push(t)
  }
  const directTexts = allTexts.filter((t) => t.match_type === 'direct').length
  const aiTexts = allTexts.length - directTexts
  console.log(
    `[Stats] 텍스트 ${allTexts.length}건 (직접 ${directTexts} + AI매칭 ${aiTexts}) → ${textsByLot.size}개 주차장`,
  )

  // 배치 처리
  const results: StatsRow[] = []
  let offset = 0

  while (offset < totalLots) {
    const lots = d1Query<ParkingLot>(
      `SELECT id, name, type, total_spaces, is_free, notes, curation_tag FROM parking_lots ORDER BY id LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    )

    if (lots.length === 0) break

    for (const lot of lots) {
      const prior = computeStructuralPrior(lot)
      const reviews = reviewsByLot.get(lot.id) ?? []
      const texts = textsByLot.get(lot.id) ?? []
      const sources = computeSourceScores(reviews, texts, now)
      const { finalScore: rawFinalScore, reliability } = computeFinalScore(prior, sources)
      const finalScore = applyCurationCap(lot, rawFinalScore)

      results.push({
        parkingLotId: lot.id,
        parkingLotName: lot.name,
        curationTag: lot.curation_tag,
        structuralPrior: prior,
        reviewScore: sources.reviewScore,
        reviewCount: sources.reviewCount,
        webScore: sources.webScore,
        webCount: sources.webCount,
        nEffective: sources.nEffective,
        finalScore,
        reliability,
      })
    }

    offset += lots.length
    console.log(`[Stats] 진행: ${offset}/${totalLots}`)
  }

  // 통계 요약
  const reliabilityCounts: Record<string, number> = {}
  const scoreBuckets = {
    '4.0-5.0 😊 초보추천': 0,
    '3.3-3.9 🙂 무난': 0,
    '2.7-3.2 😐 보통': 0,
    '2.0-2.6 😕 별로': 0,
    '1.5-1.9 💀 비추': 0,
    '1.0-1.4 🔥 헬': 0,
  }
  for (const r of results) {
    reliabilityCounts[r.reliability] = (reliabilityCounts[r.reliability] ?? 0) + 1
    const s = r.finalScore
    if (s >= 4.0) scoreBuckets['4.0-5.0 😊 초보추천']++
    else if (s >= 3.3) scoreBuckets['3.3-3.9 🙂 무난']++
    else if (s >= 2.7) scoreBuckets['2.7-3.2 😐 보통']++
    else if (s >= 2.0) scoreBuckets['2.0-2.6 😕 별로']++
    else if (s >= 1.5) scoreBuckets['1.5-1.9 💀 비추']++
    else scoreBuckets['1.0-1.4 🔥 헬']++
  }

  console.log('\n[Stats] === 결과 요약 ===')
  console.log('  신뢰도 등급 분포:')
  for (const [k, v] of Object.entries(reliabilityCounts).sort()) {
    console.log(`    ${k.padEnd(15)} ${v.toString().padStart(6)}`)
  }
  console.log('  점수 분포:')
  for (const [k, v] of Object.entries(scoreBuckets)) {
    console.log(
      `    ${k.padEnd(15)} ${v.toString().padStart(6)} (${((v / results.length) * 100).toFixed(1)}%)`,
    )
  }

  // --dry-stats: 분포 + 큐레이션 일관성만 출력하고 종료 (sweep용)
  if (isDryStats) {
    const total = results.length
    const buckets: Record<string, number> = {
      '< 2.0': 0,
      '2.0~2.5': 0,
      '2.5~3.0': 0,
      '3.0~3.1': 0,
      '3.1~3.5': 0,
      '>= 3.5': 0,
    }
    for (const r of results) {
      const s = r.finalScore
      if (s < 2.0) buckets['< 2.0']++
      else if (s < 2.5) buckets['2.0~2.5']++
      else if (s < 3.0) buckets['2.5~3.0']++
      else if (s < 3.1) buckets['3.0~3.1']++
      else if (s < 3.5) buckets['3.1~3.5']++
      else buckets['>= 3.5']++
    }
    const avg = results.reduce((s, r) => s + r.finalScore, 0) / total

    const allHell = results.filter((r) => r.curationTag === 'hell')
    const hellAbove3 = allHell.filter((r) => r.finalScore >= 3.0)
    const allEasy = results.filter((r) => r.curationTag === 'easy')
    const easyBelow3 = allEasy.filter((r) => r.finalScore < 3.0)

    console.log('\n[dry-stats] ========== 분포 ==========')
    for (const [b, cnt] of Object.entries(buckets)) {
      const pct = ((cnt / total) * 100).toFixed(1)
      const bar = '█'.repeat(Math.round((cnt / total) * 40))
      console.log(`  ${b.padEnd(10)} ${String(cnt).padStart(6)}  ${pct.padStart(5)}%  ${bar}`)
    }
    console.log(`  전체 평균: ${avg.toFixed(3)}  총 ${total}개`)

    console.log('\n[dry-stats] ========== 큐레이션 일관성 ==========')
    console.log(`  Hell ${allHell.length}개 중 >= 3.0 오분류: ${hellAbove3.length}개`)
    if (hellAbove3.length > 0) {
      for (const r of hellAbove3.slice(0, 10)) {
        console.log(`    ${r.finalScore.toFixed(2)} [${r.reliability}] ${r.parkingLotName}`)
      }
      if (hellAbove3.length > 10) console.log(`    ... 외 ${hellAbove3.length - 10}개`)
    }
    console.log(`  Easy ${allEasy.length}개 중 < 3.0: ${easyBelow3.length}개`)

    console.log('\n[dry-stats] ✅ PASS 조건: hell >= 3.0 == 0개')
    const verdict =
      hellAbove3.length === 0 ? 'PASS ✅' : hellAbove3.length <= 3 ? 'WARN ⚠️' : 'FAIL ❌'
    console.log(`[dry-stats] 현재 판정: ${verdict} (hell >= 3.0: ${hellAbove3.length}개)`)
    return
  }

  // DB 업데이트
  if (!isDryRun) {
    console.log('\n[Stats] DB 업데이트 중...')
    // SQL 파일로 배치 생성
    const CHUNK = 2000
    for (let i = 0; i < results.length; i += CHUNK) {
      const chunk = results.slice(i, i + CHUNK)
      const sql = chunk
        .map((r) => {
          const vals = [
            `'${r.parkingLotId}'`,
            r.structuralPrior,
            r.reviewScore ?? 'NULL',
            r.reviewCount,
            r.webScore ?? 'NULL',
            r.webCount,
            r.nEffective,
            r.finalScore,
            `'${r.reliability}'`,
            "datetime('now')",
          ].join(',')
          return `INSERT INTO parking_lot_stats (parking_lot_id,structural_prior,review_score,review_count,web_score,web_count,n_effective,final_score,reliability,computed_at) VALUES (${vals}) ON CONFLICT(parking_lot_id) DO UPDATE SET structural_prior=excluded.structural_prior,review_score=excluded.review_score,review_count=excluded.review_count,web_score=excluded.web_score,web_count=excluded.web_count,n_effective=excluded.n_effective,final_score=excluded.final_score,reliability=excluded.reliability,computed_at=excluded.computed_at;`
        })
        .join('\n')

      const tmpFile = join(import.meta.dirname, `_stats_batch_${i}.sql`)
      const { writeFileSync: wf, unlinkSync } = await import('fs')
      wf(tmpFile, sql, 'utf-8')

      try {
        const { execSync } = await import('child_process')
        const target = isRemote ? '--remote' : '--local'
        execSync(`npx wrangler d1 execute parking-db ${target} --file="${tmpFile}"`, {
          stdio: 'pipe',
        })
        console.log(`  배치 ${i / CHUNK + 1}: ${chunk.length}건 완료`)
      } finally {
        unlinkSync(tmpFile)
      }
    }
    console.log('[Stats] DB 업데이트 완료')
  } else {
    const outPath = join(import.meta.dirname, 'parking-stats-results.json')
    writeFileSync(outPath, JSON.stringify(results, null, 2), 'utf-8')
    console.log(`\n[Stats] 결과 저장: ${outPath}`)
  }

  // 큐레이션 태그별 점수 분포 검증 (태그는 크롤링 가이드 전용, 점수 무관)
  const hellLots = results.filter(
    (r) => r.curationTag === 'hell' && r.reliability !== 'none' && r.reliability !== 'structural',
  )
  const easyLots = results.filter(
    (r) => r.curationTag === 'easy' && r.reliability !== 'none' && r.reliability !== 'structural',
  )

  if (hellLots.length > 0) {
    const hellBelow25 = hellLots.filter((l) => l.finalScore < 2.5).length
    const hellAbove35 = hellLots.filter((l) => l.finalScore >= 3.5).length
    console.log(
      `\n[검증] Hell 태그(데이터 있음): ${hellLots.length}개 → 2.5 미만: ${hellBelow25}개, 3.5 이상: ${hellAbove35}개`,
    )
    if (hellAbove35 > 0) {
      console.log(`  ⚠️ Hell 태그이나 긍정 점수:`)
      for (const l of hellLots.filter((l) => l.finalScore >= 3.5)) {
        console.log(`    ${l.parkingLotName} (${l.parkingLotId}) — score=${l.finalScore}`)
      }
    }
  }
  if (easyLots.length > 0) {
    const easyAbove35 = easyLots.filter((l) => l.finalScore >= 3.5).length
    const easyBelow20 = easyLots.filter((l) => l.finalScore <= 2.0).length
    console.log(
      `[검증] Easy 태그(데이터 있음): ${easyLots.length}개 → 3.5 이상: ${easyAbove35}개, 2.0 이하: ${easyBelow20}개`,
    )
    if (easyBelow20 > 0) {
      console.log(`  ⚠️ Easy 태그이나 부정 점수:`)
      for (const l of easyLots.filter((l) => l.finalScore <= 2.0)) {
        console.log(`    ${l.parkingLotName} (${l.parkingLotId}) — score=${l.finalScore}`)
      }
    }
  }

  // 커버리지 비교
  const withData = results.filter((r) => r.reliability !== 'none').length
  const prevCoverage = reviewsByLot.size // 기존: 리뷰 있는 주차장만
  console.log(
    `\n[커버리지] 기존(리뷰만): ${prevCoverage}개 → 새(통합): ${withData}개 (+${withData - prevCoverage}개)`,
  )
}

main().catch(console.error)
