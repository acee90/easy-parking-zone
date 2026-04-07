# match-quality PDCA Completion Report

> **Feature**: 매칭 알고리즘 품질 개선 (+ POI 소스 정리)
> **Date**: 2026-04-07
> **Match Rate**: 95%

---

## Executive Summary

| Item | Detail |
|------|--------|
| **Feature** | 웹소스 매칭 품질 개선 (poi-cleanup + match-quality) |
| **Period** | 2026-04-07 (단일 세션) |
| **Files Changed** | 4 (scoring.ts, scoring.test.ts, naver-blogs.ts, duckduckgo-search.ts) |
| **Lines Changed** | +130 / -15 (scoring.ts 기준) |
| **DB Rows Deleted** | 36,362건 (poi 23,580 + ai_matches 11,225 + 오매칭 761 + 이름수정 2건 리셋 175) |
| **Match Rate** | 95% |

### Value Delivered

| Perspective | Content |
|-------------|---------|
| **Problem** | POI 크롤링 전략이 시설 자체 주차 콘텐츠를 인근 공영주차장에 잘못 연결 (서호2: 350건 오매칭). 제네릭 이름("제1공영주차장", "공영") 주차장이 전국 블로그와 대량 오매칭 (9개 주차장 50건+) |
| **Solution** | 1) POI 전략 제거 + 데이터 삭제 2) 키워드 품질 기반 매칭 전략 분기 — specific 식별자 유무에 따라 이름 단독 매칭 vs 이름+지역 복합 키 매칭 |
| **Function/UX Effect** | 위키 "많이 언급된 주차장" 랭킹이 실제 데이터 반영. 서호2: 350→10건, 오매칭 9개 주차장 전부 정리 |
| **Core Value** | 주차장-웹소스 매칭의 정밀도를 구조적으로 개선하여 난이도 점수와 사용자 신뢰도를 확보 |

---

## 1. What Was Done

### 1.1 POI 소스 정리 (poi-cleanup)

| 작업 | Before | After |
|------|--------|-------|
| web_sources source='poi' | 12,376건 | 0건 |
| web_sources_raw source='poi' | 11,204건 | 0건 |
| web_source_ai_matches (poi 관련) | 11,225건 | 0건 |
| 서호2 web_sources | 350건 | 10건 |
| 크롤러 POI 쿼리 전략 | naver-blogs.ts + duckduckgo-search.ts에서 활성 | 제거됨 |

**근본 원인**: poi_tags[0]("롯데백화점 잠실점")으로 "롯데백화점 잠실점 주차장" 검색 → 백화점 자체 주차 블로그가 인근 공영주차장에 연결

### 1.2 주차장 이름 수정

| 주차장 ID | Before | After | 오매칭 삭제 |
|-----------|--------|-------|:----------:|
| KA-1045126466 | 노상공영주차 | 음성읍 공영주차장 | 104건 |
| 352-2-000004 | 제1공영주차장 | 경주시 제1공영주차장 | 71건 |

### 1.3 매칭 알고리즘 개선 (match-quality)

**핵심 변경**: `scoring.ts`에 키워드 품질 기반 매칭 전략 분기 도입

```
키워드 분류: specific(고유) / generic(카테고리) / location(지역)

specific 있음 → 기존대로 이름 매칭만으로 점수 부여
specific 없음 → 이름 + 지역 동시 매칭 필요 (복합 키)
```

| 신규 함수/상수 | 역할 |
|---------------|------|
| `GENERIC_KEYWORDS` (17개) | 공영, 무료, 제1, 주변, 마을공동 등 카테고리 단어 |
| `isLocationWord()` | 시/군/구/동/읍/면/리 접미어 감지 |
| `hasSpecificIdentifier()` | 이름에 고유 식별자 존재 여부 판별 |
| `extractCity()` | 주소에서 시/군 레벨 지역명 추출 |

**변경된 함수**:
- `extractNameKeywords()` — GENERIC_KEYWORDS 필터링 추가
- `scoreBlogRelevance()` — specific 유무에 따라 매칭 전략 A/B 분기
- `getMatchConfidence()` — specific 없으면 high 차단 (AI 검증 필수)

### 1.4 오매칭 데이터 정리

7개 주차장에서 586건 삭제 + crawl_progress 리셋:
- 광교 대학로 공영 (82건), 광교 1동 공영 (80건)
- 안동시 마을공동주차장 6개 (52~69건 x 6)

---

## 2. Test Results

| Suite | Tests | Status |
|-------|:-----:|:------:|
| scoring.test.ts | 34 | All passed |
| 전체 | 134 | All passed |

신규 테스트: hasSpecificIdentifier (9건), extractCity (4건), scoreBlogRelevance 복합키 (2건), getMatchConfidence guard (1건)

---

## 3. Lessons Learned

1. **POI 전략의 근본 결함**: "{POI명} 주차장" 검색은 POI 자체 주차 콘텐츠를 반환하므로, 인근 공영주차장 매칭 소스로 부적절
2. **제네릭 이름 감지는 패턴 나열이 아닌 키워드 품질 판별이 효과적**: `isGenericName` 패턴을 15개로 늘리는 것보다, "고유 식별자가 남는지" 판별하는 `hasSpecificIdentifier`가 새로운 제네릭 이름에도 자동 대응
3. **지역+제네릭 = 복합 키**: "경주시 제1공영주차장"처럼 개별 키워드는 제네릭이지만 조합이 고유한 경우, 지역 동시 매칭으로 해결
4. **D1 대량 DELETE 시 FK 인덱스 필수**: `web_sources.raw_source_id` FK 체크에 인덱스 없이 10M rows 스캔 → `idx_ws_raw_source_id` 추가로 해결
