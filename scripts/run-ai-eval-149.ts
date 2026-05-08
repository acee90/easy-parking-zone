/**
 * #149 AI filter eval — medium tier 샘플을 Haiku로 재평가
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... bun run scripts/run-ai-eval-149.ts
 *
 * 입력: /tmp/eval-149-medium.json (eval-pipeline-149.ts 실행 후 생성)
 * 출력: /tmp/eval-149-ai-results.json
 *
 * 특징:
 * - lot_name 없이 fulltext만으로 판정 (raw 파이프라인 시뮬레이션)
 * - filter only (summary 생성 없음) → 빠르고 저렴
 * - 20건 병렬 처리
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'

const INPUT_FILE = '/tmp/eval-149-medium.json'
const OUTPUT_FILE = '/tmp/eval-149-ai-results.json'
const BATCH_SIZE = 20
const CONCURRENCY = 10

interface MediumSample {
  id: number
  title: string
  full_text: string
  lot_name: string
  ground_truth: number
}

interface AiResult {
  id: number
  filterPassed: boolean
  filterRemovedBy: string | null
  sentimentScore: number
}

// ── 평가 전용 시스템 프롬프트 (lot_name 없이, filter only) ──

const EVAL_SYSTEM_PROMPT = `주차장 관련 웹 콘텐츠를 분석하여 유용한 주차 정보 포함 여부를 판정합니다.

출력 형식 (JSON 객체만, 설명 없이):
{"filterPassed": true/false, "filterRemovedBy": null 또는 "thin"/"boilerplate"/"ad"/"realestate"/"news"/"irrelevant", "sentimentScore": 1-5}

**판정 기본 원칙: 불확실하면 filterPassed=true (통과).**

filterPassed = true 조건 (하나라도 해당하면 즉시 통과):
1. 특정 주차장의 위치·요금·운영시간·주차면수 중 하나라도 구체적으로 언급
2. 진입로·혼잡도·편의/불편에 대한 실이용자 경험 (문장 수 무관)
3. 주차 관련 실용 팁 (할인 방법, 덜 혼잡한 시간대, 진입 주의점 등)

filterPassed = false 기준 (모든 조건이 명확히 해당할 때만 제거):
- "thin": 위 1~3 조건 중 하나도 없고, 주차 언급이 "주차 가능했어요" 수준의 1문장뿐
- "boilerplate": 여러 주차장을 나열하는 집계 페이지 ("○○구 공영주차장 목록", "주변 주차장 TOP5") + 개별 상세 정보 없음
  · 단일 주차장 페이지는 주소·운영시간만 있어도 통과
- "ad": 광고·협찬 명시 ("체험단", "원고료 제공", "협찬", "쿠팡 파트너스")
- "realestate": 분양·택지가 주제이고 주차는 부수 언급
- "news": 기자 명의 보도자료 또는 지자체 공식 발표문 (주차장 이용 정보 없음)
  · 공영주차장 안내 페이지는 news가 아님
- "irrelevant": 주차 관련 내용이 단 한 문장도 없음

sentimentScore: 5=매우 긍정(진입 쉽고 면 넓음), 3=중립/정보없음, 1=매우 부정(좁고 어렵)`

async function evalItem(client: Anthropic, sample: MediumSample): Promise<AiResult> {
  const text = sample.full_text.slice(0, 2000)
  const userMsg = `제목: ${sample.title}\n\n본문:\n${text}`

  try {
    const res = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system: EVAL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
    })

    const raw = (res.content[0] as { text: string }).text.trim()
    const json = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] ?? raw)
    return {
      id: sample.id,
      filterPassed: Boolean(json.filterPassed),
      filterRemovedBy: json.filterRemovedBy ?? null,
      sentimentScore: Number(json.sentimentScore ?? 3),
    }
  } catch {
    return { id: sample.id, filterPassed: false, filterRemovedBy: 'error', sentimentScore: 3 }
  }
}

async function main() {
  if (!existsSync(INPUT_FILE)) {
    console.error(`입력 파일 없음: ${INPUT_FILE}`)
    console.error('먼저 bun run scripts/eval-pipeline-149.ts 실행 필요')
    process.exit(1)
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    console.error('ANTHROPIC_API_KEY 환경변수 필요')
    process.exit(1)
  }

  const client = new Anthropic({ apiKey })
  const samples: MediumSample[] = JSON.parse(readFileSync(INPUT_FILE, 'utf-8'))
  console.log(`\n📊 medium 샘플: ${samples.length}건`)

  // 이미 처리된 결과 로드 (재실행 시 이어받기)
  const existingResults: AiResult[] = existsSync(OUTPUT_FILE)
    ? (JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8')).results ?? [])
    : []
  const doneIds = new Set(existingResults.map((r) => r.id))
  const remaining = samples.filter((s) => !doneIds.has(s.id))
  console.log(`  완료: ${existingResults.length}건 / 남은: ${remaining.length}건`)

  if (remaining.length === 0) {
    console.log('모두 완료됨.')
    printSummary([...existingResults], samples)
    return
  }

  const allResults: AiResult[] = [...existingResults]
  let processed = 0

  for (let i = 0; i < remaining.length; i += BATCH_SIZE * CONCURRENCY) {
    const window = remaining.slice(i, i + BATCH_SIZE * CONCURRENCY)

    // CONCURRENCY 단위로 나눠 병렬 처리
    for (let j = 0; j < window.length; j += CONCURRENCY) {
      const batch = window.slice(j, j + CONCURRENCY)
      const results = await Promise.all(batch.map((s) => evalItem(client, s)))
      allResults.push(...results)
      processed += results.length

      // 진행 상황 저장
      writeFileSync(OUTPUT_FILE, JSON.stringify({ results: allResults }, null, 2))
      process.stdout.write(`\r  처리: ${processed + existingResults.length}/${samples.length}건`)
    }
  }

  console.log('\n\n✅ 완료')
  printSummary(allResults, samples)
}

function printSummary(results: AiResult[], samples: MediumSample[]) {
  const gtMap = new Map(samples.map((s) => [s.id, s.ground_truth]))
  const passed = results.filter((r) => r.filterPassed)
  const failed = results.filter((r) => !r.filterPassed)

  const removedByDist: Record<string, number> = {}
  for (const r of failed) {
    const k = r.filterRemovedBy ?? 'unknown'
    removedByDist[k] = (removedByDist[k] ?? 0) + 1
  }

  console.log(`\n── AI Filter 결과 ──`)
  console.log(
    `  통과: ${passed.length}건 (${((passed.length / results.length) * 100).toFixed(1)}%)`,
  )
  console.log(`  제거: ${failed.length}건`)
  console.log('\n  제거 사유:')
  for (const [k, v] of Object.entries(removedByDist).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${k.padEnd(15)} ${v}건`)
  }

  // filter_v2 ground truth 대비 accuracy
  const matched = results.filter((r) => gtMap.has(r.id))
  if (matched.length > 0) {
    const correct = matched.filter((r) => (r.filterPassed ? 1 : 0) === gtMap.get(r.id)).length
    const aiPass = matched.filter((r) => r.filterPassed)
    const tp = aiPass.filter((r) => gtMap.get(r.id) === 1).length
    console.log(`\n  vs filter_v2 (참고용):`)
    console.log(`    accuracy:  ${((correct / matched.length) * 100).toFixed(1)}%`)
    console.log(
      `    precision: ${aiPass.length > 0 ? ((tp / aiPass.length) * 100).toFixed(1) : 'n/a'}%`,
    )
  }

  console.log(`\n→ 결과 저장: ${OUTPUT_FILE}`)
  console.log('→ 최종 리포트: bun run scripts/eval-pipeline-149.ts --report')
}

main().catch(console.error)
