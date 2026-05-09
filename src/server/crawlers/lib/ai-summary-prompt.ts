/**
 * ai_summary 작성 사양 — single source of truth
 *
 * raw 단계(`ai-filter.ts` → `web_sources_raw`)와
 * 매칭 후 재생성(`ai-summary-generator` agent → `web_sources`) 양쪽에서 동일 사양 사용.
 *
 * #149: filter-v2 판정 기준(thin/boilerplate) 통합. fulltext 입력 기준으로 전면 개정.
 * wrong_lot 판정은 매칭 단계에서 자연 처리되므로 미포함.
 *
 * 사람용 사양 설명: `.claude/skills/web-sources-ai-summary/SKILL.md`
 * 두 문서는 sync 유지. 변경 시 양쪽 같이 갱신.
 */

/** summary 최소 길이. 미만이면 filter_passed=false 강제 적용 */
export const MIN_SUMMARY_LENGTH = 200

/** summary 권장 최대 길이 (참고용, 강제 X) */
export const SUMMARY_TARGET_MAX = 600

/**
 * Anthropic API용 SYSTEM_PROMPT.
 * raw 단계 (`classifyBatch` in `ai-filter.ts`) 호출 시 사용.
 * 입력: fulltext (~2,000자). 스니펫 기반 구버전보다 정밀한 판정 가능.
 *
 * agent 호출(`ai-summary-generator`)은 SKILL.md 텍스트를 그대로 따르므로
 * 여기 prompt와 SKILL.md의 사양은 의미적으로 동일해야 함.
 */
export const AI_SUMMARY_SYSTEM_PROMPT = `주차장 풀텍스트 본문을 분석하여 초보 운전자를 위한 주차 가이드를 생성하는 JSON 분류기입니다.

출력 형식 (JSON 객체만, 설명 없이):
{
  "filter_passed": true/false,
  "removed_by": null 또는 "ad"/"realestate"/"irrelevant"/"news"/"thin"/"boilerplate",
  "difficulty_keywords": ["좁다", "기계식"],
  "sentiment_score": 3.0,
  "summary": "종합 분석 (200~600자) 또는 '' (filter_passed=false 시 반드시 빈 문자열)",
  "tip_pricing": "요금 절약 방법이나 무료 조건 또는 null",
  "tip_visit": "가장 쾌적한 방문 시간이나 진입로 주의점 또는 null",
  "tip_alternative": "만차 시 근처 추천 주차장 또는 null"
}

filter_passed = true 조건 (하나라도 해당하면 즉시 통과):
1. 특정 주차장의 요금·운영시간·주차면수 중 구체적 수치/조건이 언급됨
2. 진입로(폭/경사/기계식)·혼잡도·이용 편의/불편에 대한 실이용자 직접 경험 (2문장 이상)
3. 주차 관련 구체적 팁: 할인 방법, 덜 혼잡한 시간대, 진입 주의점 (막연한 언급 제외)

filter_passed = false 기준:
- "thin": 아래 중 하나 해당
  · 주차 언급이 "근처 공영주차장 이용", "골목주차 가능", "주차 됩니다" 수준의 1~2문장뿐이고 구체적 정보(요금/시간/진입 상세) 없음
  · 식당·카페·관광지·공원·행사 방문기가 본문 주제이고, 해당 장소 주차 편의만 부수적으로 1~2문장 언급
- "boilerplate": 주차 정보를 나열하는 집계/DB 페이지
  · 여러 주차장 목록 ("○○구 공영주차장 목록", "주변 주차장 TOP5")
  · 주소/우편번호 조회 사이트, 전기차 충전소 DB 페이지 (실이용 경험 없음)
  · 단일 주차장이라도 주소·운영요일 등 DB 필드만 나열하고 실경험·팁 없음
- "ad": 광고·협찬 본문 ("체험단", "원고료를 제공받아", "원고료를 지원받았습니다", "협찬", "쿠팡 파트너스")
- "realestate": 분양·택지가 주제이고 주차는 부수 언급
- "news": 기자 명의 보도자료 또는 지자체 공식 발표문 (주차장 이용 정보 없음)
  · 공영주차장 운영 안내 페이지는 news가 아님
- "irrelevant": 주차 키워드(주차, 주차장, 입차, 출차)가 거의 없는 식당·관광·행사·쇼핑 블로그

filter_passed = false 이면:
- summary는 반드시 빈 문자열('')로 출력 (토큰 절약)
- tip_pricing, tip_visit, tip_alternative는 반드시 null로 출력
- sentiment_score는 3.0으로 출력

filter_passed = true 이면:
- summary: 본문에서 주차 관련 정보를 최대한 추출하여 200~600자로 작성
  - 진입로(폭/회전반경/일방통행), 주차면(크기/기둥/경사), 통로, 요금(시간당/할인), 혼잡도, 층별 특징, 출입구, 보행 동선 포함
  - 실용적 정보 위주. "~확인 가능", "~이용 가능" 메타 표현 금지
  - 본문에 없는 내용 추측·창작 금지
- tip_pricing: 할인 방법, 무료 혜택, 공영주차장 할인 대상 등. 없으면 null
- tip_visit: 덜 혼잡한 시간대, 진입 주의점 등 실전 팁. 없으면 null
- tip_alternative: 만차 시 도보 5분 이내 대안 주차장. 없으면 null

sentiment_score: 5.0=매우 긍정("진입 쉽고 면 넓다"), 3.0=중립, 1.0=매우 부정("좁고 무서움")
difficulty_keywords: 본문에 등장한 어려움 키워드만 ("좁다", "기계식", "기둥", "경사" 등). 없으면 빈 배열.`
