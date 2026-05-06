/**
 * #148 Phase C — full_text 입력 filter v2 prompt.
 *
 * raw 단계 (`ai-summary-prompt.ts`) 의 SYSTEM_PROMPT 와 분리.
 * 이 프롬프트는 **summary 출력 안 함** — filter 결정만. summary 재생성은 #141 에서.
 *
 * 입력: full_text + lot meta
 * 출력 JSON:
 *   { filter_passed, removed_by, sentiment_score, ai_difficulty_keywords }
 */

export const FILTER_V2_SYSTEM_PROMPT = `주차장 풀텍스트 본문을 분석하여 SEO 가치 있는 후기/정보 소스만 통과시키는 JSON 분류기입니다.

출력 형식 (JSON 객체만, 설명 없이):
{
  "filter_passed": true/false,
  "removed_by": null 또는 "ad"/"realestate"/"irrelevant"/"news"/"boilerplate"/"wrong_lot"/"thin",
  "sentiment_score": 1.0~5.0 (3.0 = 중립),
  "ai_difficulty_keywords": ["좁다", "기계식"]
}

판정 기준:

filter_passed = false 인 경우 (이전 raw 단계가 놓친 false positive 를 본문 전체로 재검증):
- "thin": 본문 200자 미만 또는 주차장 자체에 대한 구체 정보 부재. 단, 본문이 짧지 않고 입력 lot 에 대한 위치/요금/운영시간/주차면/무료 여부/진입/혼잡도/방문 동선 중 하나라도 구체적으로 설명하면 thin 이 아님
- "wrong_lot": 본문에 입력으로 받은 lot 이름 (또는 핵심 키워드) 이 한 번도 등장하지 않음 → 다른 주차장 얘기
- "boilerplate": SEO 자동생성 템플릿 ("Top5 저렴한 주변 주차정보", 운영시간/요금만 나열, 공식 가이드 톤). 단, 입력 lot 이름 또는 핵심 키워드가 등장하고 그 주변에 해당 lot 의 실제 요금/운영시간/주소/주차면/무료 여부/이용 팁이 있으면 boilerplate 가 아니라 통과 가능
- "ad": 광고/협찬 본문 ("쿠팡 파트너스", "체험단", "원고료를 제공받아", "상기 업체로부터 제공")
- "realestate": 분양/택지/아파트 분양 안내 ("택지개발지구", "분양", "신규 아파트 조성")
- "news": 보도자료/공공기관 발표 ("민원 증가", "조성", "운영하기로", "추진", "지자체는 발표")
- "irrelevant": 위 모두 아니지만 주차장에 대한 사용자 후기/경험 정보 0건

filter_passed = true 인 경우:
- 본문에 lot 이름 또는 핵심 키워드 명시 + 다음 중 1건 이상:
  1. 진짜 사용자 후기: 방문 경험, 진입로, 주차면, 요금, 혼잡도, 편의/불편 묘사
  2. 주차장 정보: 해당 lot 의 위치, 요금, 운영시간, 주차면수, 무료/유료 여부, 결제/할인, 접근 동선, 이용 팁
- 여러 주차장을 나열하는 문서라도 입력 lot 에 대한 개별 섹션 또는 인접 문맥에 구체 정보가 있으면 통과 가능

sentiment_score:
- 본문에서 lot 에 대한 평가 톤. 5.0 = 매우 긍정 ("진입 쉽고 면 넓다"), 3.0 = 중립 ("평범"), 1.0 = 매우 부정 ("좁고 무서움").
- filter_passed=false 면 무관 (3.0 으로).

ai_difficulty_keywords:
- 본문에 등장한 어려움 키워드만 ("좁다", "기계식", "기둥", "경사", "회전", "골뱅이" 등). 없으면 빈 배열.

주의:
- summary 필드 출력 금지. 요약은 별도 단계에서 처리됨.
- 단순 지역 주차장 목록/순위/추천 문서에서 입력 lot 이름만 나오고 해당 lot 의 구체 정보가 없으면 false.
- 명시적 광고/협찬 표시가 본문 어디든 있으면 무조건 false (광고 후기는 신뢰 불가).`

/** 단일 record 입력 인터페이스 */
export interface FilterV2Input {
  /** web_sources.id (식별용) */
  id: number
  /** parking_lots.name */
  lot_name: string
  /** parking_lots.address */
  lot_address: string
  /** web_sources.title (snippet) */
  title: string
  /** web_sources.full_text */
  full_text: string
}

export interface FilterV2Output {
  id: number
  filter_passed: boolean
  removed_by: string | null
  sentiment_score: number
  ai_difficulty_keywords: string[]
}

/** 배치 호출용 user message (JSON-friendly) */
export function buildFilterV2UserPrompt(inputs: FilterV2Input[]): string {
  return inputs
    .map(
      (i) => `--- record id=${i.id} ---
lot_name: ${i.lot_name}
lot_address: ${i.lot_address}
title: ${i.title}
full_text: ${i.full_text.slice(0, 6000)}`,
    )
    .join('\n\n')
}
