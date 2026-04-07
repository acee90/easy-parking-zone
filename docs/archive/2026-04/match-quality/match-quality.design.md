# 매칭 알고리즘 품질 개선 Design Document

> **Summary**: 키워드를 고유/제네릭/지역으로 분류하여, 고유 식별자가 없는 주차장은 이름+지역 동시 매칭을 요구한다
>
> **Project**: easy-parking-zone
> **Version**: 0.3.0
> **Author**: junhee
> **Date**: 2026-04-07
> **Status**: Draft
> **Planning Doc**: [match-quality.plan.md](../../01-plan/features/match-quality.plan.md)

---

## 1. Overview

### 1.1 핵심 아이디어

추출된 키워드를 **고유(specific) / 제네릭(generic) / 지역(location)** 으로 분류하고,
고유 식별자 유무에 따라 매칭 전략을 분기한다.

```
키워드 분류:
  specific  — 고유 식별자: 코엑스, 마장축산물시장, 광교, 석촌호수, 가정교회
  generic   — 카테고리 단어: 공영, 무료, 노상, 제1, 부설, 주변, 마을공동
  location  — 지역명: 경주시, 송파구, 태화동, 이의동

매칭 전략:
  specific 있음 → 기존대로 (이름 매칭만으로 점수 부여)
  specific 없음 → 이름 매칭 + 지역 매칭 동시 충족 시에만 nameMatched
                  (지역+제네릭 조합이 복합 키가 되는 경우를 허용하되, 지역 불일치는 차단)
```

### 1.2 예시

| 주차장 이름 | 블로그 | specific | 지역일치 | 결과 |
|------------|--------|:--------:|:--------:|:----:|
| 코엑스 주차장 | "코엑스 주차 후기" | 코엑스 | - | **매칭** |
| 광교 대학로 공영 | "광교 카페거리 주차장" | 광교 | - | **매칭** |
| 경주시 제1공영주차장 | "경주 제1공영주차장 후기" | 없음 | O (경주) | **매칭** |
| 경주시 제1공영주차장 | "예천 제1공영주차장 중단" | 없음 | X (예천≠경주) | **차단** |
| 태화동 마을공동주차장 | "안동 태화동 마을주차장" | 없음 | O (안동·태화동) | **매칭** |
| 태화동 마을공동주차장 | "울산 태화동 맛집 주차" | 없음 | X (울산≠안동) | **차단** |
| 제1공영주차장 | 어떤 블로그든 | 없음 | 구/동 없음 | **차단** (지역 검증 불가) |

### 1.3 Design Principles

- 패턴 나열이 아닌 키워드 품질 기반 판단 → 새로운 제네릭 이름에도 자동 대응
- specific 없는 이름도 매칭 가능하되, **지역 동시 매칭이 필수**
- 기존 `isGenericName()` 크롤러 쿼리 용도는 유지, 매칭 스코어링에는 새 로직 사용

### 1.4 수정 범위

- `src/server/crawlers/lib/scoring.ts` — 로직 변경
- `src/server/crawlers/lib/scoring.test.ts` — 테스트 추가

---

## 2. Implementation Details

### 2.1 제네릭/지역 키워드 상수 추가

```typescript
/** 카테고리성 제네릭 단어 — 주차장 유형/속성을 나타내지만 특정 장소를 식별하지 않음 */
const GENERIC_KEYWORDS = new Set([
  '공영', '민영', '노상', '노외', '무료', '유료',
  '부설', '임시', '제1', '제2', '제3', '제4', '제5',
  '주변', '인근', '마을공동', '마을',
])

/** 지역명 접미사 — 행정구역을 나타내는 단어 */
function isLocationWord(word: string): boolean {
  return /[시군구동읍면리]$/.test(word)
}

/** 키워드가 고유 식별자인지 판별 */
function isSpecificKeyword(kw: string): boolean {
  return !GENERIC_KEYWORDS.has(kw) && !isLocationWord(kw)
}
```

### 2.2 `extractNameKeywords()` 변경

기존 반환값에서 generic 키워드만 제거. location 키워드는 유지 (region 매칭에 활용될 수 있으므로):

```typescript
export function extractNameKeywords(parkingName: string): string[] {
  // ... 기존 1~5단계 동일 ...

  // 6. 중복 제거 + 제네릭 키워드 필터링
  return [...new Set(keywords)].filter(kw => !GENERIC_KEYWORDS.has(kw))
}
```

### 2.3 `extractCity()` — 시/군 레벨 지역 추출 (신규)

`extractRegion()`은 구/동 레벨만 추출하여 시 단위 주소에서 작동하지 않음.
제네릭 이름의 지역 검증에 사용할 시/군 레벨 추출 함수 추가:

```typescript
/**
 * 주소에서 시/군 이름을 추출한다.
 * "경상북도 경주시 중앙로 47번길 13" → "경주"
 * "충북 음성군 음성읍 읍내리 624-5" → "음성"
 * "서울특별시 강남구 역삼동" → "" (광역시는 구 레벨이므로 빈 문자열)
 */
export function extractCity(address: string): string {
  const match = address.match(/\s(\S+?)(시|군)\s/)
  if (!match) return ''
  if (/특별|광역/.test(match[1])) return ''
  return match[1]
}
```

### 2.4 `hasSpecificIdentifier()` — 고유 식별자 판별 (신규)

주차장 이름에서 generic/location을 모두 제거한 뒤, 의미 있는 고유 부분이 남는지 확인:

```typescript
function hasSpecificIdentifier(parkingName: string): boolean {
  let cleaned = parkingName.toLowerCase().replace(NAME_SUFFIX, '').trim()

  // 제네릭 키워드 제거
  for (const gk of GENERIC_KEYWORDS) {
    cleaned = cleaned.replaceAll(gk, '')
  }

  // 지역명(시/군/구/동/읍/면/리 접미) 제거
  cleaned = cleaned.replace(/\S*[시군구동읍면리]/g, '')

  // 공백 정리 후 잔여 길이 확인
  cleaned = cleaned.replace(/\s+/g, '').trim()
  return cleaned.length >= 2
}
```

예시:
- `"코엑스 주차장"` → suffix 제거 "코엑스" → generic/location 제거 → "코엑스" (3자) → **true**
- `"경주시 제1공영주차장"` → suffix 제거 "경주시 제1" → "제1" 제거 → "경주시" 제거 → "" (0자) → **false**
- `"광교 대학로 공영"` → "공영" 제거 → location 제거 → "광교대학" (4자) → **true**
- `"태화동 가정교회 주변 마을공동주차장"` → suffix 제거 → "주변","마을공동" 제거 → "태화동" 제거 → "가정교회" (4자) → **true**

### 2.5 `scoreBlogRelevance()` 변경 — 핵심

specific 유무에 따라 매칭 전략을 분기:

```typescript
export function scoreBlogRelevance(
  title: string,
  description: string,
  parkingName: string,
  address: string,
): number {
  // ... 게이트, 노이즈 필터 동일 ...

  let score = 0
  let nameMatched = false

  const nameKeywords = extractNameKeywords(parkingName)
  const hasSpecific = hasSpecificIdentifier(parkingName)

  // 지역 매칭 (먼저 계산 — 아래 분기에서 사용)
  const region = extractRegion(address).toLowerCase()
  const regionWords = region.split(/\s+/).filter((w) => w.length >= 2)
  const regionMatched = regionWords.some((rw) => titleLower.includes(rw) || descLower.includes(rw))

  // 지역 매칭 보강: specific 없는 경우 시/군 레벨도 확인
  const city = extractCity(address)
  const cityMatched = city ? combined.includes(city) : false
  const locationMatched = regionMatched || cityMatched

  if (regionMatched) score += 20

  // 이름 매칭 (전략 분기)
  const nameInTitle = nameKeywords.some((kw) => titleLower.includes(kw))
  const nameInDesc = nameKeywords.some((kw) => descLower.includes(kw))

  if (hasSpecific) {
    // A. 고유 식별자 있음 → 기존대로 이름 매칭만으로 점수 부여
    if (nameInTitle) { score += 40; nameMatched = true }
    if (nameInDesc) { score += 20; nameMatched = true }
  } else {
    // B. 고유 식별자 없음 → 이름 + 지역 동시 매칭 필요 (복합 키)
    if ((nameInTitle || nameInDesc) && locationMatched) {
      if (nameInTitle) score += 40
      if (nameInDesc) score += 20
      nameMatched = true
    }
  }

  // 주차 키워드 보너스 (기존 동일)
  if (titleLower.includes('주차') || descLower.includes('주차')) score += 20

  // ── 보정 규칙 (기존 동일) ──
  if (!nameMatched) {
    score = Math.min(score, 40)
  }

  if (nameMatched && regionMatched === false) {
    const province = extractProvince(address)
    if (province && !combined.includes(province)) {
      score = Math.max(0, score - 30)
    }
  }

  return Math.min(100, score)
}
```

**효과**:
- specific 있음: 기존 동작 유지 (코엑스, 마장축산물시장 등)
- specific 없음 + 지역 일치: 매칭 허용 (경주 제1공영주차장 ↔ 경주 블로그)
- specific 없음 + 지역 불일치: nameMatched=false → 최대 40점 → none (예천 블로그 차단)

### 2.6 `getMatchConfidence()` 변경

specific 식별자 없으면 high 불가:

```typescript
  // score >= 40 통과 후...

  // (NEW) 고유 식별자 없으면 high 불가 — AI 검증 필수
  if (!hasSpecificIdentifier(parkingName)) {
    return { score, confidence: 'medium' }
  }

  // 이하 기존 로직 동일 (maxMatchLen >= 6 체크, 도로명/시설명 guard 등)
```

---

## 3. Test Cases (scoring.test.ts)

### 3.1 hasSpecificIdentifier

```typescript
describe('hasSpecificIdentifier', () => {
  it('returns true for unique names', () => {
    expect(hasSpecificIdentifier('코엑스 주차장')).toBe(true)       // 코엑스
    expect(hasSpecificIdentifier('광교 대학로 공영')).toBe(true)    // 광교, 대학
    expect(hasSpecificIdentifier('태화동 가정교회 주변 마을공동주차장')).toBe(true)  // 가정교회
  })
  it('returns false for generic+location only', () => {
    expect(hasSpecificIdentifier('경주시 제1공영주차장')).toBe(false)
    expect(hasSpecificIdentifier('제1공영주차장')).toBe(false)
    expect(hasSpecificIdentifier('노상공영주차')).toBe(false)
    expect(hasSpecificIdentifier('무료주차장')).toBe(false)
    expect(hasSpecificIdentifier('태화동 마을공동주차장')).toBe(false)
  })
})
```

### 3.2 extractNameKeywords — 제네릭 필터링

```typescript
it('filters out generic keywords', () => {
  const kws = extractNameKeywords('광교 대학로 공영')
  expect(kws).not.toContain('공영')
  expect(kws).toContain('광교')
})
```

### 3.3 scoreBlogRelevance — 복합 키 매칭

```typescript
it('allows generic name match when location co-occurs', () => {
  // 경주시 제1공영주차장 ↔ 경주 블로그 → 매칭
  const score = scoreBlogRelevance(
    '경주 제1공영주차장 이용 후기',
    '경주시 제1공영주차장에서 주차했습니다',
    '경주시 제1공영주차장',
    '경상북도 경주시 중앙로 47번길 13',
  )
  expect(score).toBeGreaterThan(40)
})

it('blocks generic name match when location differs', () => {
  // 경주시 제1공영주차장 ↔ 예천 블로그 → 차단
  const score = scoreBlogRelevance(
    '예천군 제1공영주차장 운영 중단',
    '예천군 제1공영주차장 임시주차장 안내',
    '경주시 제1공영주차장',
    '경상북도 경주시 중앙로 47번길 13',
  )
  expect(score).toBeLessThanOrEqual(40)
})

it('scores normally for specific name regardless of location', () => {
  const score = scoreBlogRelevance(
    '코엑스 주차장 후기',
    '코엑스에서 주차 쉬웠습니다',
    '코엑스 주차장',
    '서울 강남구 삼성동',
  )
  expect(score).toBeGreaterThan(40)
})
```

### 3.4 getMatchConfidence — specific 없으면 medium

```typescript
it('returns medium for name with no specific identifier', () => {
  const result = getMatchConfidence(
    '경주 제1공영주차장 주차 후기',
    '경주시 제1공영주차장에서 주차했습니다',
    '경주시 제1공영주차장',
    '경상북도 경주시 중앙로 47번길 13',
  )
  expect(result.confidence).toBe('medium')
})

it('still returns high for specific name match', () => {
  const result = getMatchConfidence(
    '마장축산물시장 주차장 후기',
    '마장축산물시장에서 주차했습니다',
    '마장축산물시장 주차장',
    '서울 성동구 마장동',
  )
  expect(result.confidence).toBe('high')
})
```

---

## 4. Implementation Order

```
Step 1: scoring.ts — GENERIC_KEYWORDS 상수 + isLocationWord() + hasSpecificIdentifier() 추가
Step 2: scoring.ts — extractNameKeywords 끝에 GENERIC_KEYWORDS 필터 추가
Step 3: scoring.ts — extractCity() 추가
Step 4: scoring.ts — scoreBlogRelevance 분기 (specific 유무에 따라 매칭 전략 변경)
Step 5: scoring.ts — getMatchConfidence에 specific 없으면 medium guard 추가
Step 6: scoring.test.ts — 테스트 케이스 추가
Step 7: bun --bun run test 통과 확인
Step 8: bun --bun run build 성공 확인
Step 9: DB — 오매칭 7개 주차장 데이터 정리 + crawl_progress 리셋
```

---

## 5. Verification Checklist

- [ ] `bun --bun run test` 전체 통과 (기존 + 신규)
- [ ] `bun --bun run build` 성공
- [ ] `hasSpecificIdentifier("코엑스 주차장")` → true
- [ ] `hasSpecificIdentifier("경주시 제1공영주차장")` → false
- [ ] `hasSpecificIdentifier("태화동 가정교회 주변 마을공동주차장")` → true
- [ ] 경주 제1공영 ↔ 경주 블로그 → 매칭 (지역 동시 충족)
- [ ] 경주 제1공영 ↔ 예천 블로그 → 차단 (지역 불일치)
- [ ] 코엑스 → 기존대로 정상 매칭
- [ ] 기존 getMatchConfidence high 테스트 (마장축산물시장) 통과
