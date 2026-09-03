/**
 * 주차장 종합 요약(parking_lot_stats.ai_summary) 작성 사양 — single source of truth
 *
 * 글 하나를 요약하는 사양(`ai-summary-prompt.ts`)과는 층이 다르다.
 * 저쪽은 **글 1건 → 요약 1건**이고, 이쪽은 **주차장 1곳의 모든 근거 → 요약 1건**이다.
 * 근거는 한꺼번에 쌓이지 않으므로 두 층의 생성 시점도 다르다
 * (글 요약은 매칭 시점, 종합 요약은 근거가 바뀐 뒤 큐 → 크론).
 *
 * 근거 배분(리뷰 대비 웹 몇 건까지)은 `lot-summary-input.ts` 가 정한다.
 * 이 파일은 **그 입력을 어떻게 쓰라고 지시할지**만 담는다.
 *
 * 크론(`lot-summary-batch.ts`)과 스크립트(`scripts/generate-lot-summary.ts`)가 공유한다.
 */

export interface LotSummaryResult {
  summary: string
  tip_pricing: string | null
  tip_visit: string | null
  tip_alternative: string | null
}

export interface LotSummaryLot {
  name: string
  address: string
}

export interface LotSummaryWebRow {
  /** web_sources.ai_summary */
  content: string
}

export interface LotSummaryReviewRow {
  overall_score: number
  entry_score: number
  space_score: number
  passage_score: number
  exit_score: number
  comment: string | null
}

/** 종합 요약 최소 길이 — 이보다 짧으면 근거를 못 쓴 것으로 보고 저장하지 않는다 */
export const MIN_LOT_SUMMARY_LENGTH = 80

export const LOT_SUMMARY_SYSTEM_PROMPT = `당신은 주차장 정보 큐레이터입니다. 블로그·커뮤니티·사용자 리뷰를 분석해 아래 JSON 형식만 출력하세요. JSON 외 다른 텍스트는 절대 금지입니다.

출력 형식:
{
  "summary": "주차장 전체 특징 2~3문장 (120~180자). 진입 난이도·주차면 넓이·통로·요금·혼잡 시간대 위주.",
  "tip_pricing": "요금 구조·할인 조건·무료 여부 1~2문장. 근거 없으면 null.",
  "tip_visit": "진입 경로·혼잡 시간대·주의사항 1~2문장. 근거 없으면 null.",
  "tip_alternative": "근처 대안 주차장·대중교통 연계 1~2문장. 근거 없으면 null."
}

근거의 무게 (중요):
- 입력은 [1순위] 이용자 후기 / [2순위] 블로그·커뮤니티 요약 / [참고] 시드 리뷰로 나뉩니다.
- **하나의 종합 요약을 씁니다.** "블로그에서는 ~, 이용자는 ~" 처럼 출처별로 나눠 쓰지 마세요.
  읽는 사람에게는 이 주차장이 어떤 곳인지 하나로 읽혀야 합니다.
- 다만 **판단이 갈리면 [1순위]를 따릅니다.** 직접 대본 사람의 말이 웹 글보다 정확합니다.
  예: 블로그는 "넓다"인데 이용자 후기가 "주말엔 만차"라면 만차 쪽을 살려 쓰세요.
- [1순위]에만 있는 구체적인 사실(특정 층·입구·시간대)은 우선해서 담으세요.
- [1순위]가 0건이면 [2순위]만으로 쓰되, 없는 이용자 경험을 지어내지 마세요.
- [참고] 시드 리뷰만으로 단정하지 마세요.

공통 규칙:
- 반드시 경어체(~습니다, ~합니다, ~입니다)만 사용, 평서체(~다, ~이다) 금지
- "AI가 분석했다" "데이터에 따르면" 같은 메타 표현 금지
- 과장, 이모지, 마크다운 금지
- 모순 의견은 "대체로 ~하지만 ~라는 의견도 있습니다" 형식으로 균형 있게
- 근거가 빈약한 필드는 null로 설정`

function formatReview(r: LotSummaryReviewRow, i: number, prefix: string): string {
  const c = r.comment ? `"${r.comment.slice(0, 200)}"` : '(코멘트 없음)'
  return `[${prefix}${i + 1}] 종합 ${r.overall_score}/5 · 진입 ${r.entry_score} · 주차면 ${r.space_score} · 통로 ${r.passage_score} · 출차 ${r.exit_score} — ${c}`
}

/**
 * 입력 블록을 [1순위]/[2순위]/[참고] 로 나눠 쓴다.
 *
 * 순서와 라벨이 곧 무게다 — 프롬프트에 "1순위를 따르라"고 적는 것만으로는
 * 21:1 로 들어간 웹 글에 이용자 후기가 묻힌다(`lot-summary-input.ts` 실측).
 * 개수 제한은 호출부가 `webQuotaFor` 로 이미 걸어서 넘긴다.
 */
export function buildLotSummaryUserPrompt(
  lot: LotSummaryLot,
  web: LotSummaryWebRow[],
  reviews: LotSummaryReviewRow[],
  seedReviews: LotSummaryReviewRow[] = [],
): string {
  const webBlock =
    web.length > 0 ? web.map((s) => `- ${s.content}`).join('\n') : '(블로그·커뮤니티 언급 없음)'
  const reviewBlock =
    reviews.length > 0
      ? reviews.map((r, i) => formatReview(r, i, 'R')).join('\n')
      : '(사용자 리뷰 없음)'
  const seedBlock =
    seedReviews.length > 0
      ? seedReviews.map((r, i) => formatReview(r, i, 'S')).join('\n')
      : '(없음)'

  return `대상 주차장:
- 이름: ${lot.name}
- 주소: ${lot.address}

[1순위] 우리 사이트 이용자 후기 (${reviews.length}건) — 실제로 여기 주차해 본 사람이 직접 남긴 글입니다.
아래 [2순위] 는 ${web.length}건만 실었습니다. 이용자 후기가 묻히지 않도록 일부러 줄인 것입니다.
${reviewBlock}

[2순위] 블로그·커뮤니티 요약 (${web.length}건) — 웹에서 모은 글을 요약한 것입니다.
${webBlock}

[참고] 운영자가 넣은 시드 리뷰 (${seedReviews.length}건) — 이용자가 쓴 글이 아닙니다. 보조 근거로만 쓰세요.
${seedBlock}`
}
