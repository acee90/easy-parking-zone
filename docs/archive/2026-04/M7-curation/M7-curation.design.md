# M7 초보운전 큐레이션 Design Document

> **Summary**: 블로그 데이터에서 AI로 주변 장소를 추출하고 위키 상세 페이지에 큐레이션 섹션을 추가하는 구현 설계
>
> **Project**: easy-parking-zone
> **Version**: 0.1.0
> **Author**: junhee
> **Date**: 2026-04-03
> **Status**: Draft
> **Planning Doc**: [M7-curation.plan.md](../../01-plan/features/M7-curation.plan.md)

---

## 1. Overview

### 1.1 Design Goals

- 기존 `ai-filter.ts` 패턴을 재사용하여 최소 코드로 AI 추출 파이프라인 구축
- 위키 상세 페이지에 자연스럽게 섹션 추가 (기존 UI 패턴 유지)
- 정확도 필터링: 동일 장소가 2개+ 블로그에서 언급된 경우만 노출

### 1.2 Design Principles

- **기존 패턴 재사용**: `classifyBatch()` 구조를 그대로 따르는 `extractNearbyPlaces()` 함수
- **1회성 스크립트 + incremental**: 초기 배치 처리 후 신규 블로그만 추가 처리
- **Graceful degradation**: 추출 결과 없으면 섹션 숨김

---

## 2. Architecture

### 2.1 데이터 흐름

```
[1회성 스크립트]
web_sources (341건, score >= 3.5 주차장)
  ↓ 주차장별 블로그 묶기
  ↓ extractNearbyPlaces() — Haiku API 배치
  ↓ JSON: {places: [{name, category, tip}]}
  ↓ 중복 제거 + 2회 이상 언급 필터
  ↓ nearby_places INSERT

[위키 페이지 로딩]
/wiki/$slug → fetchParkingDetail() + fetchNearbyPlaces()
  ↓ NearbyPlaces 컴포넌트 렌더링
```

### 2.2 파일 구조

```
migrations/
  0031_nearby_places.sql            ← 테이블 생성

src/db/schema.ts                    ← nearbyPlaces 스키마 추가

src/server/crawlers/lib/
  nearby-extractor.ts               ← AI 추출 모듈 (ai-filter.ts 패턴)

scripts/
  extract-nearby-places.ts          ← 1회성 배치 스크립트

src/server/parking.ts               ← fetchNearbyPlaces 서버 함수 추가
src/routes/wiki/$slug.tsx           ← NearbyPlaces 섹션 추가
```

---

## 3. 파일별 상세 설계

### 3.1 `migrations/0031_nearby_places.sql`

```sql
CREATE TABLE nearby_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  name TEXT NOT NULL,
  category TEXT NOT NULL,       -- cafe | restaurant | park | tourist | market | hospital | etc
  tip TEXT,                     -- "주말 오전이 한적해요", "떡볶이 맛집" 등
  mention_count INTEGER NOT NULL DEFAULT 1,  -- 몇 개 블로그에서 언급됐는지
  source_blog_ids TEXT,         -- JSON array of web_sources.id (출처 추적)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_nearby_places_lot ON nearby_places(parking_lot_id);
```

**Plan 대비 변경사항:**
- `source_blog_id` (단일) → `source_blog_ids` (JSON 배열): 여러 블로그에서 추출한 동일 장소를 병합
- `mention_count` 추가: 2회 이상 언급 필터링용

### 3.2 `src/db/schema.ts` — nearbyPlaces 추가

```typescript
export const nearbyPlaces = sqliteTable(
  'nearby_places',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    parkingLotId: text('parking_lot_id').notNull().references(() => parkingLots.id),
    name: text('name').notNull(),
    category: text('category').notNull(),
    tip: text('tip'),
    mentionCount: integer('mention_count').notNull().default(1),
    sourceBlogIds: text('source_blog_ids'), // JSON array
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [index('idx_nearby_places_lot').on(table.parkingLotId)],
)
```

### 3.3 `src/server/crawlers/lib/nearby-extractor.ts`

`ai-filter.ts`의 `classifyBatch()` 패턴을 따르는 AI 추출 모듈.

```typescript
const HAIKU_MODEL = 'claude-haiku-4-5-20251001'

export interface NearbyPlace {
  name: string
  category: 'cafe' | 'restaurant' | 'park' | 'tourist' | 'market' | 'hospital' | 'etc'
  tip: string | null
}

export interface ExtractionInput {
  parkingName: string
  blogTitle: string
  blogContent: string  // 앞 500자 (비용 절감)
}

const SYSTEM_PROMPT = `주차장 근처 블로그 글에서 주변 장소를 추출하는 JSON 분류기입니다.

출력 형식 (JSON 객체만, 설명 없이):
{
  "places": [
    {"name": "장소명", "category": "cafe|restaurant|park|tourist|market|hospital|etc", "tip": "한줄 팁 또는 null"}
  ]
}

규칙:
- 블로그에서 언급된 실제 상호명/장소명만 추출 (일반 명사 X)
- category: cafe(카페/베이커리), restaurant(맛집/식당), park(공원/산책로), tourist(관광지/명소), market(시장/마트), hospital(병원/의원), etc(기타)
- tip: 블로그에서 언급한 방문 팁이 있으면 20자 이내로. 없으면 null
- 주차장 자체는 제외, 주변 장소만
- 장소가 없으면 {"places": []}
- 최대 5개까지`

export async function extractNearbyPlaces(
  inputs: ExtractionInput[],
  apiKey: string,
): Promise<NearbyPlace[][]>
```

**핵심 설계:**
- 입력: 주차장별 블로그 묶음 (1 주차장 = N 블로그 → 1 API 호출)
- 비용 최적화: 블로그 content 앞 500자만 사용
- 배치: 주차장 1개씩 호출 (블로그 여러 건을 한 프롬프트에)
- max_tokens: 300 (장소 5개 × ~60 토큰)

### 3.4 `scripts/extract-nearby-places.ts` — 1회성 배치 스크립트

```
실행 흐름:
1. DB에서 score >= 3.5 주차장 + web_sources JOIN
2. 주차장별로 블로그 그룹핑
3. 주차장별 extractNearbyPlaces() 호출 (Haiku)
4. 동일 장소명 중복 제거 → mention_count 합산
5. mention_count >= 2인 것만 nearby_places INSERT
6. 결과 리포트 출력

환경변수: ANTHROPIC_API_KEY, D1 접속 (wrangler)
배치 사이즈: 5 주차장씩 병렬 (API rate limit 고려)
예상 비용: 341건 × ~$0.001 = ~$0.34
```

**mention_count 로직:**
```
주차장 A의 블로그 3건에서 추출:
  블로그1: [{name: "카페모카", category: "cafe"}]
  블로그2: [{name: "카페모카", category: "cafe"}, {name: "중앙공원", category: "park"}]
  블로그3: [{name: "중앙공원", category: "park"}]

→ 병합 결과:
  카페모카: mention_count=2, source_blog_ids=[1,2] → ✅ 저장
  중앙공원: mention_count=2, source_blog_ids=[2,3] → ✅ 저장
```

### 3.5 `src/server/parking.ts` — fetchNearbyPlaces

```typescript
export const fetchNearbyPlaces = createServerFn({ method: 'GET' })
  .inputValidator((input: { parkingLotId: string }) => input)
  .handler(async ({ data }) => {
    const db = getDb()
    const rows = await db
      .select()
      .from(schema.nearbyPlaces)
      .where(eq(schema.nearbyPlaces.parkingLotId, data.parkingLotId))
      .orderBy(desc(schema.nearbyPlaces.mentionCount))
      .limit(10)

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      category: row.category,
      tip: row.tip,
      mentionCount: row.mentionCount,
    }))
  })
```

### 3.6 `src/routes/wiki/$slug.tsx` — NearbyPlaces 섹션

**위치**: 미니맵(`WikiMiniMap`)과 탭(`ParkingTabs`) 사이

```tsx
// 카테고리 아이콘 매핑
const CATEGORY_ICON: Record<string, { icon: string; label: string }> = {
  cafe:       { icon: '☕', label: '카페' },
  restaurant: { icon: '🍽️', label: '맛집' },
  park:       { icon: '🌳', label: '공원' },
  tourist:    { icon: '🎫', label: '관광' },
  market:     { icon: '🛒', label: '시장' },
  hospital:   { icon: '🏥', label: '병원' },
  etc:        { icon: '📍', label: '기타' },
}
```

**컴포넌트 구조:**
```
<section> "주변 갈만한 곳"
  ├── <h2> 제목 + 장소 수 뱃지
  └── <div> 카드 그리드 (2열)
        └── <div> 카드
              ├── 카테고리 아이콘 + 라벨
              ├── 장소명 (bold)
              ├── 팁 텍스트 (있으면)
              └── "N개 블로그에서 추천" (mention_count)
```

**데이터 로딩**: `loader`에서 `fetchNearbyPlaces` 병렬 호출
```typescript
loader: async ({ params }) => {
  const id = parseIdFromSlug(params.slug)
  const [lot, nearbyPlaces] = await Promise.all([
    fetchParkingDetail({ data: { id } }),
    fetchNearbyPlaces({ data: { parkingLotId: id } }),
  ])
  return { lot, nearbyPlaces }
}
```

**조건부 렌더링**: `nearbyPlaces.length > 0`일 때만 섹션 표시

---

## 4. 구현 순서

| Step | 파일 | 설명 | Issue |
|------|------|------|-------|
| 1 | `migrations/0031_nearby_places.sql` | 테이블 생성 | #78 |
| 2 | `src/db/schema.ts` | Drizzle 스키마 추가 | #78 |
| 3 | `src/server/crawlers/lib/nearby-extractor.ts` | AI 추출 모듈 | #78 |
| 4 | `scripts/extract-nearby-places.ts` | 배치 스크립트 실행 | #78 |
| 5 | `src/server/parking.ts` | fetchNearbyPlaces 함수 | #79 |
| 6 | `src/routes/wiki/$slug.tsx` | NearbyPlaces UI 섹션 | #79 |

---

## 5. 타입 정의

```typescript
// src/types/parking.ts에 추가
export interface NearbyPlaceInfo {
  id: number
  name: string
  category: 'cafe' | 'restaurant' | 'park' | 'tourist' | 'market' | 'hospital' | 'etc'
  tip?: string
  mentionCount: number
}
```

---

## 6. 에러 처리 및 엣지 케이스

| 케이스 | 처리 |
|--------|------|
| AI가 빈 배열 반환 | 정상 — 해당 주차장은 nearby_places 없음 |
| AI가 잘못된 JSON 반환 | `ai-filter.ts`의 `parseOne()` 패턴으로 fallback |
| 동일 장소명 다른 카테고리 | 첫 번째 카테고리 채택, mention_count 합산 |
| 블로그 없는 주차장 | 스킵 — 섹션 미노출 |
| mention_count 1인 장소 | 저장하지 않음 (노이즈 필터) |
