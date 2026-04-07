# POI 소스 정리 및 크롤러 개선 Design Document

> **Summary**: POI 소스 데이터 삭제, 스코어 재계산, 크롤러 POI 전략 제거의 구체적 구현 설계
>
> **Project**: easy-parking-zone
> **Version**: 0.1.0
> **Author**: junhee
> **Date**: 2026-04-07
> **Status**: Draft
> **Planning Doc**: [poi-cleanup.plan.md](../../01-plan/features/poi-cleanup.plan.md)

---

## 1. Overview

### 1.1 Design Goals

- web_sources/web_sources_raw에서 source='poi' 데이터 완전 삭제
- 영향받는 931개 주차장의 parking_lot_stats 재계산
- 크롤러 코드에서 POI 쿼리 전략 제거로 재발 방지
- 빌드 깨짐 없이 깔끔하게 코드 정리

### 1.2 Design Principles

- 삭제 전 카운트 검증으로 안전한 데이터 작업
- 스코어 재계산은 기존 `compute-parking-stats.ts` 스크립트 재활용
- 크롤러 코드 변경은 최소 범위로 제한

---

## 2. Implementation Details

### 2.1 DB 데이터 삭제 (D1 remote, 수동 실행)

#### 실행 순서

```
1. COUNT 검증 (삭제 전)
2. 영향받는 parking_lot_id 목록 추출 → 로컬 보관
3. web_sources DELETE
4. web_sources_raw DELETE
5. COUNT 검증 (삭제 후)
6. 스코어 재계산
```

#### SQL 명령

```sql
-- Step 1: 삭제 전 건수 확인
SELECT COUNT(*) FROM web_sources WHERE source = 'poi';
SELECT COUNT(*) FROM web_sources_raw WHERE source = 'poi';

-- Step 2: 영향받는 주차장 ID 추출 (재계산용)
SELECT DISTINCT parking_lot_id FROM web_sources WHERE source = 'poi';

-- Step 3: web_sources 삭제
DELETE FROM web_sources WHERE source = 'poi';

-- Step 4: web_sources_raw 삭제
DELETE FROM web_sources_raw WHERE source = 'poi';

-- Step 5: 삭제 후 검증
SELECT COUNT(*) FROM web_sources WHERE source = 'poi';
SELECT COUNT(*) FROM web_sources_raw WHERE source = 'poi';
```

### 2.2 스코어 재계산

기존 `scripts/compute-parking-stats.ts`를 `--remote`로 실행.
이 스크립트는 **전체 주차장**을 대상으로 재계산하므로, 별도 ID 필터링이 불필요.

```bash
bun run scripts/compute-parking-stats.ts --remote
```

### 2.3 크롤러 코드 변경

#### 2.3.1 `src/server/crawlers/naver-blogs.ts`

**변경 1**: `QueryStrategy` 타입에서 `'poi'` 제거

```typescript
// Before
type QueryStrategy = 'name' | 'poi' | 'region'

// After
type QueryStrategy = 'name' | 'region'
```

**변경 2**: `LotRow` 인터페이스에서 `poi_tags` 제거

```typescript
// Before
interface LotRow {
  id: string
  name: string
  address: string
  poi_tags: string | null
}

// After
interface LotRow {
  id: string
  name: string
  address: string
}
```

**변경 3**: `buildQueries()` 함수에서 POI 전략 블록 제거

```typescript
// Before (line 94-122)
function buildQueries(lot: LotRow): CrawlQuery[] {
  const region = extractRegion(lot.address)
  const queries: CrawlQuery[] = []

  // A: 이름이 고유하면 항상 포함
  if (!isGenericName(lot.name)) {
    queries.push({ strategy: 'name', query: `${lot.name} 주차장 ${region}`.trim() })
  }

  // B: POI 태그가 있으면 추가
  let poiTags: string[] = []
  if (lot.poi_tags) {
    try {
      poiTags = JSON.parse(lot.poi_tags)
    } catch {
      /* malformed JSON → skip */
    }
  }
  if (poiTags.length > 0) {
    queries.push({ strategy: 'poi', query: `${poiTags[0]} 주차장` })
  }

  // C: A도 B도 없으면 지역 폴백
  if (queries.length === 0) {
    queries.push({ strategy: 'region', query: `${region} 주차장 추천` })
  }

  return queries
}

// After
function buildQueries(lot: LotRow): CrawlQuery[] {
  const region = extractRegion(lot.address)
  const queries: CrawlQuery[] = []

  // A: 이름이 고유하면 항상 포함
  if (!isGenericName(lot.name)) {
    queries.push({ strategy: 'name', query: `${lot.name} 주차장 ${region}`.trim() })
  }

  // B: A가 없으면 지역 폴백
  if (queries.length === 0) {
    queries.push({ strategy: 'region', query: `${region} 주차장 추천` })
  }

  return queries
}
```

**변경 4**: `selectPriorityLots()` SQL에서 `p.poi_tags` 제거

```typescript
// Before
`SELECT p.id, p.name, p.address, p.poi_tags ...`

// After
`SELECT p.id, p.name, p.address ...`
```

**변경 5**: 파일 헤더 JSDoc에서 POI 전략 언급 제거

```typescript
// Before (line 6-9)
 *   A. 이름 기반: "{주차장명} 주차장"           — 고유한 이름
 *   B. POI 기반:  "{POI} 주차장"               — poi_tags 활용
 *   C. 지역 기반: "{동} 주차장 추천"            — 폴백

// After
 *   A. 이름 기반: "{주차장명} 주차장 {지역}"   — 고유한 이름
 *   B. 지역 기반: "{동} 주차장 추천"            — 폴백
```

#### 2.3.2 `src/server/crawlers/duckduckgo-search.ts`

naver-blogs.ts와 동일한 5가지 변경 적용:

1. `QueryStrategy` 타입: `'poi'` 제거
2. `LotRow` 인터페이스: `poi_tags` 제거
3. `buildQueries()`: POI 전략 블록 제거
4. `selectPriorityLots()` SQL: `p.poi_tags` 제거
5. 파일 헤더 JSDoc: POI 전략 언급 제거

---

## 3. Implementation Order

```
Step 1: DB 데이터 삭제 (wrangler d1 execute --remote)
Step 2: 스코어 재계산 (bun run scripts/compute-parking-stats.ts --remote)
Step 3: naver-blogs.ts 코드 수정 (5개 변경)
Step 4: duckduckgo-search.ts 코드 수정 (5개 변경)
Step 5: bun --bun run build 검증
Step 6: 위키 페이지 데이터 검증
Step 7: deploy
```

---

## 4. Verification Checklist

- [ ] `SELECT COUNT(*) FROM web_sources WHERE source = 'poi'` → 0
- [ ] `SELECT COUNT(*) FROM web_sources_raw WHERE source = 'poi'` → 0
- [ ] 서호2(123-2-000016) web_sources 건수 ≤ 10
- [ ] 위키 홈 "웹에서 많이 언급된 주차장" TOP 10이 합리적
- [ ] `bun --bun run build` 성공
- [ ] 크롤러 코드에 `'poi'` 문자열 잔재 없음
