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

filter_passed = false 판정 기준:
- "thin": 주차 실질 내용이 부족한 경우
  · 식당·관광지·쇼핑몰 방문기에서 "주차 가능", "주차 무료", "주차했어요" 수준의 1~3문장 부수 언급
  · 주차장이 글의 핵심 주제가 아니고 배경 정보로만 등장
  · 본문 전체 길이의 10% 미만이 주차 관련 내용이고 구체 정보(위치/요금/진입/혼잡) 없음
- "boilerplate": 공공 데이터 집계 또는 SEO 자동생성 페이지
  · 운영요일/관리기관/구획수/기본요금/추가요금 등 DB 구조화 필드를 나열하고 실이용자 서술 없음
  · 공영주차장 정보 집계 사이트 패턴 (주소·운영시간·요금 나열, 관리기관 표기)
  · "Top N 저렴한 주변 주차장", "○○구 공영주차장 목록" 등 여러 주차장 집계 페이지
  · 단, 진입로 주의점·혼잡도·이용 팁 등 실경험 정보가 포함되어 있으면 통과
- "ad": 광고·협찬 본문 ("쿠팡 파트너스", "체험단", "원고료를 제공받아", "상기 업체로부터 제공")
- "realestate": 분양·택지 안내 ("택지개발지구", "분양", "신규 아파트 조성")
- "news": 보도자료·공공기관 발표 ("민원 증가", "조성", "운영하기로", "추진", "지자체는 발표")
- "irrelevant": 위 모두 아니지만 주차장에 대한 사용자 후기·경험 정보 0건

filter_passed = true 조건:
- 다음 중 1건 이상 포함:
  1. 실이용자 방문 경험: 진입로, 주차면, 요금, 혼잡도, 편의·불편 묘사 (2문장 이상)
  2. 주차장 구체 정보: 위치, 요금, 운영시간, 주차면수, 무료·유료, 결제·할인, 접근 동선, 이용 팁
- 여러 주차장 나열 문서라도 개별 섹션에 구체 정보 있으면 통과 가능

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
