#!/usr/bin/env bun
/**
 * Filter v2 평가 스크립트 #149 — STRICT 룰 기반
 *
 * Rule: lot_name 무시, title + full_text만으로 판정
 * 판정 기준: /tmp/eval-filter-prompt.txt 기준
 *
 * Usage:
 *   bun run scripts/eval-filter-149-strict.ts 0 1 2 3 4
 */

import { readFileSync, writeFileSync } from 'node:fs'

interface ChunkItem {
  id: number
  title: string
  full_text: string
  lot_name: string
  ground_truth: number
}

interface FilterResult {
  id: number
  filterPassed: boolean
  filterRemovedBy: string | null
  sentimentScore: number
}

interface ChunkOutput {
  results: FilterResult[]
}

// ─── 평가 핵심 로직 ───

/**
 * filterPassed = true 조건 (하나라도 해당하면 즉시 통과):
 * 1. 특정 주차장의 위치·요금·운영시간·주차면수 중 하나라도 구체적으로 언급
 * 2. 진입로·혼잡도·편의/불편에 대한 실이용자 경험 (문장 수 무관)
 * 3. 주차 관련 실용 팁 (할인 방법, 덜 혼잡한 시간대, 진입 주의점 등)
 */
function shouldPass(text: string): boolean {
  // 조건 1: 위치·요금·운영시간·주차면수 구체적 언급
  const hasLocation =
    /주소|[가-힣]{2,4}구|[가-힣]{2,4}동|번지|도로명|[도로명|\d+번지]|지번|주|강남|강북|마포|용산|성동|광진|동대문|중랑|성북|강북|도봉|노원|은평|서대문|마포|종로|중구|성내|영등포|동작|관악|서초|강남|송파|강동/.test(
      text,
    )
  const hasTime = /[0-9]{1,2}:[0-9]{2}|시간|오픈|닫음|운영|OPEN|CLOSE/.test(text) // 운영시간
  const hasPrice =
    /[0-9]+원|시간당|시간|요금|비용|가격|할인|무료|유료|1시간|30분|1일|월정기|결제/.test(text)
  const hasParkingSpaces = /[0-9]+대|[0-9]+면|주차면수|구획수/.test(text)

  const concreteInfo = hasLocation || hasTime || hasPrice || hasParkingSpaces
  if (concreteInfo) return true

  // 조건 2: 실이용자 경험 — 진입·혼잡·편의성 언급
  const hasUserExperience =
    /진입|출차|입차|혼잡|복잡|좁|넓|좁은|넓은|빨리|느리|오래|빨리진출|빨리입장/.test(text)
  const hasUserOpinion = /어렵|쉽|힘들|불편|편리|편하|좋|나쁜|아쉬운/.test(text)

  if (hasUserExperience && hasUserOpinion) return true

  // 조건 3: 실용 팁 — 할인, 시간대, 주의점 등
  const hasTip =
    /할인|가성비|팁|꿀팁|주의|피해|추천|한가|피크|시간대|시간|야간|낮|아침|저녁|피하/.test(text)
  const hasSpecific = /[0-9]시|[0-9]시간|[0-9]분|한가한|버시는|몰|정체|혼|밀려|빨라|느려/.test(text)

  if (hasTip && hasSpecific) return true

  return false
}

/**
 * filterPassed = false 기준
 * 모든 조건이 명확히 해당할 때만 제거
 */
function getRemovalReason(text: string): string | null {
  const isVeryShort = text.length < 80
  const hasOnlyBriefParking = /주차\s*(?:가능|했|할수|가능했)/.test(text) && isVeryShort

  // "thin": 위 조건 중 하나도 없고, 주차 언급이 "주차 가능했어요" 수준 1문장
  if (hasOnlyBriefParking) {
    return 'thin'
  }

  // "boilerplate": 여러 주차장 나열 (구/동별 TOP 목록 등) + 개별 상세 정보 없음
  const isListFormat =
    /TOP\s*\d+|구\s*주차장|동\s*주차장|주변\s*주차장|근처\s*주차장|추천\s*주차장|주차장\s*목록|가이드|안내/.test(
      text,
    )
  const noDetailInfo = !/주소|[0-9]{1,2}:[0-9]{2}|[0-9]+원|[0-9]+대|[0-9]+면|운영/.test(text)

  if (isListFormat && noDetailInfo) {
    return 'boilerplate'
  }

  // "ad": 광고·협찬 명시
  if (/협찬|광고|체험단|원고료|제공|쿠팡\s*파트너|후기단|선정|제품협찬|홍보\s*포스팅/.test(text)) {
    return 'ad'
  }

  // "realestate": 분양·택지가 주제, 주차는 부수
  const isRealEstate = /분양|택지|개발|건설|건축|아파트분양|주택분양|부동산|아파트|주택/.test(text)
  const noParkingExperience = !/사용|이용|경험|후기|주차했|방문|다녀|이용했|어렵|쉽|불편|편리/.test(
    text,
  )

  if (isRealEstate && noParkingExperience) {
    return 'realestate'
  }

  // "news": 기자명의 보도자료 또는 지자체 공식 발표 (주차 이용 정보 없음)
  const isNews =
    /기자\s*=|뉴스|보도자료|보도|발표|지자체|구청|시의회|시장|민원|추진|조성|사업/.test(text)
  const noParkingInfo = !/이용|주차|후기|경험|리뷰|방문|다녀/.test(text)

  if (isNews && noParkingInfo) {
    return 'news'
  }

  // "irrelevant": 주차 관련 내용 단 한 문장도 없음
  const hasParkingMention =
    /주차|주차장|차량|정차|자리|면|대|시간|요금|원|비용|할인|예약|예약금/.test(text)

  if (!hasParkingMention) {
    return 'irrelevant'
  }

  return null
}

function evaluateItem(item: ChunkItem): FilterResult {
  const text = `${item.title}\n${item.full_text}`

  // 먼저 통과 조건 확인
  if (shouldPass(text)) {
    return {
      id: item.id,
      filterPassed: true,
      filterRemovedBy: null,
      sentimentScore: 3,
    }
  }

  // 제거 이유 확인
  const reason = getRemovalReason(text)

  if (reason) {
    return {
      id: item.id,
      filterPassed: false,
      filterRemovedBy: reason,
      sentimentScore: 3,
    }
  }

  // 불확실하면 통과 (default pass)
  return {
    id: item.id,
    filterPassed: true,
    filterRemovedBy: null,
    sentimentScore: 3,
  }
}

async function processChunk(chunkIndex: number): Promise<void> {
  const inputPath = `/tmp/eval-149-chunk-${String(chunkIndex).padStart(2, '0')}.json`
  const outputPath = `/tmp/eval-149-partial-${String(chunkIndex).padStart(2, '0')}.json`

  try {
    const content = readFileSync(inputPath, 'utf-8')
    const items: ChunkItem[] = JSON.parse(content)

    const results: FilterResult[] = items.map(evaluateItem)

    const output: ChunkOutput = { results }
    writeFileSync(outputPath, JSON.stringify(output, null, 0))

    // 통계 출력
    const passed = results.filter((r) => r.filterPassed).length
    const removed = results.filter((r) => !r.filterPassed).length
    const removedDist = {} as Record<string, number>

    results.forEach((r) => {
      if (r.filterRemovedBy) {
        removedDist[r.filterRemovedBy] = (removedDist[r.filterRemovedBy] || 0) + 1
      }
    })

    const reasonStr = Object.entries(removedDist)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ')

    console.log(
      `chunk-${String(chunkIndex).padStart(2, '0')}: ${items.length} items → PASS ${passed} (${((100 * passed) / items.length).toFixed(1)}%), REMOVE ${removed} (${reasonStr})`,
    )
  } catch (error) {
    console.error(`chunk-${String(chunkIndex).padStart(2, '0')} ERROR:`, error)
  }
}

async function main() {
  const args = process.argv
    .slice(2)
    .map(Number)
    .filter((x) => !isNaN(x))
  const chunks = args.length > 0 ? args : [0, 1, 2, 3, 4]

  // 순차 처리
  for (const chunk of chunks) {
    await processChunk(chunk)
  }

  console.log('\n✓ Complete')
}

main().catch(console.error)
