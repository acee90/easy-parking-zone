/**
 * lot summary 재생성용 청크 프롬프트 파일 빌더 (#142)
 *
 * data/lots_for_lot_summary.json 을 읽어,
 * Haiku subagent가 바로 읽을 수 있는 프롬프트 파일을 청크 단위로 생성.
 *
 * Usage:
 *   bun run scripts/build-lot-summary-chunks.ts
 *   bun run scripts/build-lot-summary-chunks.ts --input=data/lots_for_lot_summary.json --chunk-size=10 --output-dir=/tmp/lot-summary-chunks
 *   bun run scripts/build-lot-summary-chunks.ts --eval          # 첫 1개 청크만 생성
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'

const args = process.argv.slice(2)
const inputPath =
  args.find((a) => a.startsWith('--input='))?.split('=')[1] ?? 'data/lots_for_lot_summary.json'
const chunkSize = parseInt(
  args.find((a) => a.startsWith('--chunk-size='))?.split('=')[1] ?? '10',
  10,
)
const outputDir =
  args.find((a) => a.startsWith('--output-dir='))?.split('=')[1] ?? '/tmp/lot-summary-chunks'
const evalMode = args.includes('--eval')

// ── 시스템 프롬프트 (generate-lot-summary.ts 와 동일 규칙, 배치 출력 형식) ──
const SYSTEM_PROMPT = `당신은 주차장 정보 큐레이터입니다. 입력된 주차장별 블로그 요약과 사용자 리뷰를 분석해
아래 JSON 배열만 출력하세요. 배열 외 다른 텍스트는 절대 금지입니다.

출력 형식 (JSON 배열, 입력 주차장 순서와 동일):
[
  {
    "id": "KA-...",
    "summary": "주차장 전체 특징 2~3문장 (120~180자). 진입 난이도·주차면 넓이·통로·요금·혼잡 시간대 위주.",
    "tip_pricing": "요금 구조·할인 조건·무료 여부 1~2문장. 근거 없으면 null.",
    "tip_visit": "진입 경로·혼잡 시간대·주의사항 1~2문장. 근거 없으면 null.",
    "tip_alternative": "근처 대안 주차장·대중교통 연계 1~2문장. 근거 없으면 null."
  }
]

공통 규칙:
- 반드시 경어체(~습니다, ~합니다, ~입니다)만 사용, 평서체(~다, ~이다) 금지
- "AI가 분석했다" "데이터에 따르면" 같은 메타 표현 금지
- 과장, 이모지, 마크다운 금지
- 모순 의견은 "대체로 ~하지만 ~라는 의견도 있습니다" 형식으로 균형 있게
- 근거가 빈약한 필드는 null로 설정
- 데이터 부족으로 summary 생성 불가한 경우 summary를 ""(빈 문자열)로`

const MIN_WEB_SUMMARIES = parseInt(
  args.find((a) => a.startsWith('--min-web='))?.split('=')[1] ?? '5',
  10,
)
const MAX_WEB_SUMMARIES = parseInt(
  args.find((a) => a.startsWith('--max-web='))?.split('=')[1] ?? '999',
  10,
)

interface LotInput {
  id: string
  name: string
  address: string
  web_summaries: string[]
  reviews: string[]
}

function buildUserBlock(lot: LotInput): string {
  const webBlock =
    lot.web_summaries.length > 0
      ? lot.web_summaries.map((s) => `- ${s}`).join('\n')
      : '(블로그·커뮤니티 언급 없음)'

  const reviewBlock = lot.reviews.length > 0 ? lot.reviews.join('\n') : '(사용자 리뷰 없음)'

  return [
    `### [${lot.id}] ${lot.name} (${lot.address})`,
    `블로그 요약 ${lot.web_summaries.length}건:`,
    webBlock,
    `사용자 리뷰 ${lot.reviews.length}건:`,
    reviewBlock,
  ].join('\n')
}

function buildChunkPrompt(lots: LotInput[]): string {
  const userBlocks = lots.map(buildUserBlock).join('\n---\n')
  return `${SYSTEM_PROMPT}\n\n${userBlocks}`
}

function main() {
  const lots: LotInput[] = JSON.parse(readFileSync(resolve(inputPath), 'utf-8'))

  const filteredLots = lots.filter(
    (l) =>
      l.web_summaries.length >= MIN_WEB_SUMMARIES && l.web_summaries.length <= MAX_WEB_SUMMARIES,
  )
  const targetLots = evalMode ? filteredLots.slice(0, chunkSize) : filteredLots
  const totalChunks = Math.ceil(targetLots.length / chunkSize)

  mkdirSync(outputDir, { recursive: true })

  console.log(`=== lot summary 청크 빌드 ===`)
  console.log(`입력: ${inputPath} (${lots.length}개 lots)`)
  const maxLabel = MAX_WEB_SUMMARIES === 999 ? '' : ` ~ ${MAX_WEB_SUMMARIES}`
  console.log(
    `필터: web_summaries >= ${MIN_WEB_SUMMARIES}${maxLabel} → ${filteredLots.length}개 lots`,
  )
  console.log(`모드: ${evalMode ? 'EVAL (첫 1개 청크)' : `전체 (${totalChunks}개 청크)`}`)
  console.log(`청크 크기: ${chunkSize} lots/청크`)
  console.log(`출력 디렉토리: ${outputDir}`)

  for (let i = 0; i < targetLots.length; i += chunkSize) {
    const chunk = targetLots.slice(i, i + chunkSize)
    const chunkIdx = Math.floor(i / chunkSize)
    const fileName = `chunk-${String(chunkIdx).padStart(4, '0')}.txt`
    const filePath = resolve(outputDir, fileName)

    writeFileSync(filePath, buildChunkPrompt(chunk), 'utf-8')

    if (chunkIdx % 50 === 0 || evalMode) {
      console.log(`  chunk-${String(chunkIdx).padStart(4, '0')}: ${chunk.length}개 lots`)
    }
  }

  console.log(`\n완료: ${totalChunks}개 청크 → ${outputDir}`)
  if (evalMode) {
    console.log(`\nEval 실행:`)
    console.log(`  cat ${outputDir}/chunk-0000.txt | claude -p - --model claude-haiku-4-5-20251001`)
  }
}

main()
