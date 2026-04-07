# match-quality Gap Analysis

> **Feature**: 매칭 알고리즘 품질 개선
> **Date**: 2026-04-07
> **Design Doc**: [match-quality.design.md](../02-design/features/match-quality.design.md)

---

## Match Rate: 95%

---

## Design vs Implementation 비교

| # | Design 항목 | 구현 상태 | 일치 |
|---|------------|----------|:----:|
| 2.1 | GENERIC_KEYWORDS 상수 (17개) | scoring.ts:133-151 — 17개 동일 | O |
| 2.1 | isLocationWord() 함수 | scoring.ts:154-156 — `/[시군구동읍면리]$/` 동일 | O |
| 2.1 | isSpecificKeyword() 함수 | **미구현** — Design에 명시되었으나, 독립 함수로 추출하지 않고 hasSpecificIdentifier 내부에서 동일 로직을 인라인 처리 | △ |
| 2.2 | extractNameKeywords GENERIC_KEYWORDS 필터 | scoring.ts:246 — `.filter(kw => !GENERIC_KEYWORDS.has(kw))` 동일 | O |
| 2.3 | extractCity() 함수 | scoring.ts:189-194 — regex, 광역시 제외 로직 동일 | O |
| 2.4 | hasSpecificIdentifier() 함수 | scoring.ts:162-182 — Design 대비 `주차$` 제거 추가 (Design에 없던 개선) | O+ |
| 2.5 | scoreBlogRelevance 전략 분기 (hasSpecific) | scoring.ts:289-328 — 지역 먼저 계산, A/B 분기, locationMatched 사용 동일 | O |
| 2.6 | getMatchConfidence specific guard | scoring.ts:378-380 — `!hasSpecificIdentifier` → medium 동일 | O |
| 3.1 | hasSpecificIdentifier 테스트 | scoring.test.ts — true 4건 + false 5건 추가 | O |
| 3.2 | extractNameKeywords 제네릭 필터 테스트 | scoring.test.ts — "공영" 미포함, "광교" 포함 확인 | O |
| 3.3 | scoreBlogRelevance 복합 키 매칭 테스트 | scoring.test.ts — 경주 매칭/예천 차단/코엑스 정상 3건 | O |
| 3.4 | getMatchConfidence specific guard 테스트 | scoring.test.ts — medium 반환 확인 | O |
| 3.3 | extractCity 테스트 | scoring.test.ts — 경주/음성/수원 + 광역시 빈 문자열 | O |
| 4.9 | DB 오매칭 7개 주차장 정리 | 586건 삭제 + crawl_progress 7건 리셋 완료 | O |

---

## Gap 목록

### Gap 1: isSpecificKeyword 독립 함수 미추출 (Minor)

- **Design**: `isSpecificKeyword()` 함수를 export하여 외부에서도 사용 가능하게 정의
- **구현**: `hasSpecificIdentifier()` 내부에서 로직을 인라인 처리 (split → filter → isLocationWord)
- **영향**: 기능적으로 동일한 결과. 현재 외부 사용처가 없으므로 실질적 gap 없음
- **판정**: 의도적 간소화 — 수정 불필요

---

## Verification Checklist

- [x] `bun --bun run test` 전체 통과 (34/34 scoring tests)
- [x] `bun --bun run build` 성공
- [x] `hasSpecificIdentifier("코엑스 주차장")` → true
- [x] `hasSpecificIdentifier("경주시 제1공영주차장")` → false
- [x] `hasSpecificIdentifier("태화동 가정교회 주변 마을공동주차장")` → true
- [x] 경주 제1공영 ↔ 경주시 블로그 → 매칭 (score > 40)
- [x] 경주 제1공영 ↔ 예천 블로그 → 차단 (score ≤ 40)
- [x] 코엑스 → 기존대로 정상 매칭
- [x] 기존 getMatchConfidence high 테스트 (마장축산물시장) 통과
