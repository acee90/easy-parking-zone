# 매칭 알고리즘 품질 개선 Planning Document

> **Summary**: 제네릭 주차장 이름의 오매칭을 방지하도록 scoring.ts의 isGenericName, scoreBlogRelevance, getMatchConfidence를 개선한다
>
> **Project**: easy-parking-zone
> **Version**: 0.1.0
> **Author**: junhee
> **Date**: 2026-04-07
> **Status**: Draft

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | "제1공영주차장", "공영", "마을공동주차장" 같은 제네릭 이름이 전국의 무관한 블로그와 매칭되어 50건 이상 오매칭 주차장 9개 발생 |
| **Solution** | isGenericName 패턴 확장 + 제네릭 키워드 감점 + 지역 검증 강화 (시/군 레벨) |
| **Function/UX Effect** | 위키 웹소스 카운트가 정확해지고, 오매칭으로 인한 잘못된 난이도 점수 산출이 줄어듦 |
| **Core Value** | 주차장-웹소스 매칭의 정밀도를 높여 서비스 데이터 신뢰성을 확보한다 |

---

## 1. Overview

### 1.1 현재 문제

50건 이상 web_sources가 매칭된 9개 주차장을 검수한 결과, **전부 오매칭 다수**.

| 주차장 | 건수 | 오매칭 원인 |
|--------|------|------------|
| 광교 대학로 공영 | 82 | "공영" 2글자 키워드가 수원시 내 모든 공영주차장 블로그와 매칭 |
| 광교 1동 공영 | 80 | 동일 |
| 제1공영주차장 (경주) | 71 | "제1공영주차장" 전국에 수십 개 존재, 이름 정확 매칭 → high 신뢰도로 AI 검증 없이 저장 |
| 안동시 마을주차장 6개 | 52~69 | "마을공동주차장" 제네릭 + kingbeginner 템플릿 블로그 대량 매칭 |

### 1.2 근본 원인 (scoring.ts 코드 레벨)

**원인 1**: `isGenericName()` 패턴 부족
- "제1공영주차장" → 패턴 `/^제?\d+주차장$/`는 "제1주차장"만 매칭, "공영" 삽입 시 미감지
- "노상공영주차" → "주차"로 끝나는 이름 미감지 (패턴은 "주차장" 종료만)
- 시설명만 있는 주차장 ("도서관", "종합운동장") 미감지

**원인 2**: `scoreBlogRelevance()`에서 짧은 제네릭 키워드 과대 평가
- `extractNameKeywords("광교 대학로 공영")` → `["공영", "광교", "대학로", ...]`
- "공영"(2글자)이 어느 블로그든 "공영주차장" 언급하면 nameMatched = true → +40~60점

**원인 3**: `getMatchConfidence()`에서 제네릭 이름의 정확 매칭을 high로 판정
- "제1공영주차장" = 7글자 → `maxMatchLen >= 6 && hasParkingKw` → **high** 신뢰도
- high는 AI 검증 없이 바로 저장 → 전국 "제1공영주차장" 블로그가 경주에 전부 연결

**원인 4**: 지역 검증이 광역시/도 레벨만
- `extractProvince()` → "경북" vs "경북" = 통과 (경주 vs 예천 구분 불가)
- 같은 도 내 다른 시/군의 동명 주차장 블로그가 전부 통과

### 1.3 Related Documents

- [스코어링 알고리즘](../../archive/2026-03/crawlers/parking-scoring-algorithm.md)
- [크롤링 파이프라인 v2](../../poi-pipeline-v2.md)
- 수정 대상: `src/server/crawlers/lib/scoring.ts`

---

## 2. Scope

### 2.1 In Scope

1. `isGenericName()` 패턴 확장
2. `extractNameKeywords()`에서 제네릭 키워드 필터링
3. `scoreBlogRelevance()`에서 제네릭 이름 감점 규칙 추가
4. `getMatchConfidence()`에서 제네릭 이름은 high 대신 medium 강제
5. 지역 검증을 시/군 레벨로 강화
6. 기존 오매칭 데이터 정리 (9개 주차장)

### 2.2 Out of Scope

- match-to-lots.ts FTS 검색 로직 변경
- AI 필터 프롬프트 개선
- 주차장 이름 데이터 일괄 정제

---

## 3. Implementation Plan

### 3.1 `isGenericName()` 패턴 확장

현재 10개 패턴 → 추가:

```typescript
// 현재 미감지 → 추가
/^제?\d+공영주차장$/,          // "제1공영주차장", "제2공영주차장"
/^(노상|노외)?(공영|민영)?주차$/, // "노상공영주차", "공영주차"
/^무료주차장?$/,                // "무료주차장", "무료주차"
/^(도서관|종합운동장|호수공원|체육관|시민회관|구민회관)(\s*부설)?주차장?$/,
/마을공동주차장$/,              // "XX동 YY 주변 마을공동주차장"
```

### 3.2 `extractNameKeywords()`에서 제네릭 단어 필터링

추출된 키워드 중 그 자체가 제네릭인 단어를 제거:

```typescript
const GENERIC_KEYWORDS = new Set([
  '공영', '민영', '노상', '노외', '무료', '유료',
  '부설', '임시', '제1', '제2', '제3',
  '주변', '인근', '앞', '옆',
])

// 키워드 추출 후 필터링
keywords = keywords.filter(kw => !GENERIC_KEYWORDS.has(kw))
```

### 3.3 `scoreBlogRelevance()`에 제네릭 이름 감점

```typescript
// 이름이 제네릭이면 지역 매칭 필수
if (isGenericName(parkingName) && !regionMatched) {
  score = Math.min(score, 20) // threshold 미달로 none 처리
}
```

### 3.4 `getMatchConfidence()`에 제네릭 이름 guard

```typescript
// 제네릭 이름은 절대 high가 아닌 medium (AI 검증 필수)
if (isGenericName(parkingName)) {
  return { score, confidence: 'medium' }
}
```

### 3.5 지역 검증 시/군 레벨 강화

`extractProvince()` 외에 `extractCity()` 추가:

```typescript
// "경상북도 경주시 중앙로 47번길 13" → "경주"
export function extractCity(address: string): string {
  const match = address.match(/\s(\S+?[시군구])\s/)
  return match ? match[1].replace(/[시군구]$/, '') : ''
}
```

`scoreBlogRelevance()`에서 제네릭 이름일 때 시/군 레벨 매칭 요구:

```typescript
if (isGenericName(parkingName) && nameMatched) {
  const city = extractCity(address)
  if (city && !combined.includes(city)) {
    score = Math.max(0, score - 40) // 시/군 불일치 시 대폭 감점
  }
}
```

### 3.6 기존 오매칭 데이터 정리

9개 주차장의 web_sources 전부 삭제 + crawl_progress 리셋:
- 광교 대학로 공영 (203-2-000002)
- 광교 1동 공영 (203-2-000001)
- 안동시 마을주차장 6개 (354-2-000420/430/460/600/610/620/630)

(제1공영주차장, 노상공영주차는 이미 정리 완료)

---

## 4. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| 제네릭 판정이 과도하면 정상 매칭도 차단 | 실제 관련 블로그가 매칭 안 됨 | medium으로 떨어뜨리지 none으로 버리지 않음 → AI 검증 기회 유지 |
| extractCity 파싱 실패 | 시/군 검증이 작동 안 함 | city 빈 문자열이면 감점하지 않음 (기존 동작 유지) |
| GENERIC_KEYWORDS 목록 누락 | 일부 제네릭 키워드 미필터 | 데이터 기반으로 점진 추가 가능 |

---

## 5. Verification

- [ ] `isGenericName("제1공영주차장")` → true
- [ ] `isGenericName("노상공영주차")` → true
- [ ] `isGenericName("마을공동주차장")` → true (또는 "XX 마을공동주차장")
- [ ] `isGenericName("석촌호수 서호주차장")` → false (고유 이름)
- [ ] `extractNameKeywords("광교 대학로 공영")`에 "공영" 미포함
- [ ] `getMatchConfidence("제1공영주차장 블로그", ..., "제1공영주차장", ...)` → medium (not high)
- [ ] `extractCity("경상북도 경주시 중앙로 47번길 13")` → "경주"
- [ ] `bun --bun run build` 성공
- [ ] `bun --bun run test` 통과 (scoring 관련 테스트가 있다면)
