# 큐레이션 가이드 페이지 Design Document

> **Summary**: 지역별 주차 가이드 목록 + 상세 페이지의 라우트, 서버 함수, UI 구현 설계
>
> **Project**: easy-parking-zone
> **Version**: 0.1.0
> **Author**: junhee
> **Date**: 2026-04-07
> **Status**: Draft
> **Planning Doc**: [curation-guide.plan.md](../../01-plan/features/curation-guide.plan.md)

---

## 1. Overview

### 1.1 Design Goals

- 17개 광역 지역별 주차 가이드 페이지 자동 생성
- 기존 위키 패턴(createFileRoute, createServerFn, rowToParkingLot) 재사용
- SEO 최적화 (meta, og, 시맨틱 HTML)

### 1.2 Design Principles

- 추가 DB 테이블 없이 기존 parking_lots + parking_lot_stats 쿼리만으로 구성
- 위키 홈(`/wiki`)과 동일한 RankingSection 컴포넌트 패턴 재사용

---

## 2. 지역 코드 맵

```typescript
// src/lib/regions.ts (신규)
export const REGIONS = [
  { slug: 'seoul', name: '서울', prefix: '서울' },
  { slug: 'busan', name: '부산', prefix: '부산' },
  { slug: 'daegu', name: '대구', prefix: '대구' },
  { slug: 'incheon', name: '인천', prefix: '인천' },
  { slug: 'gwangju', name: '광주', prefix: '광주' },
  { slug: 'daejeon', name: '대전', prefix: '대전' },
  { slug: 'ulsan', name: '울산', prefix: '울산' },
  { slug: 'sejong', name: '세종', prefix: '세종' },
  { slug: 'gyeonggi', name: '경기', prefix: '경기' },
  { slug: 'gangwon', name: '강원', prefix: '강원' },
  { slug: 'chungbuk', name: '충북', prefix: '충북' },
  { slug: 'chungnam', name: '충남', prefix: '충남' },
  { slug: 'jeonbuk', name: '전북', prefix: '전북' },
  { slug: 'jeonnam', name: '전남', prefix: '전남' },
  { slug: 'gyeongbuk', name: '경북', prefix: '경북' },
  { slug: 'gyeongnam', name: '경남', prefix: '경남' },
  { slug: 'jeju', name: '제주', prefix: '제주' },
] as const

export type RegionSlug = (typeof REGIONS)[number]['slug']

export function findRegion(slug: string) {
  return REGIONS.find(r => r.slug === slug)
}

export function getRegionPrefix(slug: string): string {
  return findRegion(slug)?.prefix ?? ''
}
```

---

## 3. 서버 함수

### 3.1 `fetchGuideList()` — 가이드 목록 데이터

```typescript
// src/server/parking.ts에 추가
export const fetchGuideList = createServerFn({ method: 'GET' }).handler(async () => {
  const db = getDb()
  // 지역별 요약 통계
  const rows = await db.all(sql.raw(`
    SELECT
      CASE
        WHEN address LIKE '서울%' THEN 'seoul'
        WHEN address LIKE '부산%' THEN 'busan'
        ...  -- 17개 지역
      END as region_slug,
      COUNT(*) as total,
      SUM(CASE WHEN is_free = 1 THEN 1 ELSE 0 END) as free_count,
      ROUND(AVG(total_spaces), 0) as avg_spaces
    FROM parking_lots
    GROUP BY region_slug
    HAVING region_slug IS NOT NULL
  `))
  return rows
})
```

### 3.2 `fetchGuideDetail(slug)` — 가이드 상세 데이터

```typescript
export const fetchGuideDetail = createServerFn({ method: 'GET' })
  .inputValidator((input: { slug: string }) => input)
  .handler(async ({ data }) => {
    const prefix = getRegionPrefix(data.slug)
    if (!prefix) return null

    const db = getDb()
    const baseWhere = `p.address LIKE '${prefix}%'`

    // 1. 요약 통계
    const summary = await db.get(sql.raw(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN p.is_free = 1 THEN 1 ELSE 0 END) as free_count,
        ROUND(AVG(p.total_spaces), 0) as avg_spaces
      FROM parking_lots p WHERE ${baseWhere}
    `))

    // 2. 초보 추천 (easy tag 또는 score >= 3.5)
    const easyRows = await db.all(sql.raw(`
      SELECT p.*, s.final_score as avg_score, ... FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE ${baseWhere} AND (p.curation_tag = 'easy' OR s.final_score >= 3.5)
      ORDER BY s.final_score DESC LIMIT 10
    `))

    // 3. 무료 주차장 (면수 큰 순)
    const freeRows = await db.all(sql.raw(`
      SELECT p.*, s.final_score as avg_score, ... FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE ${baseWhere} AND p.is_free = 1
      ORDER BY p.total_spaces DESC LIMIT 10
    `))

    // 4. 넓은 주차장 (200면+)
    const largeRows = await db.all(sql.raw(`
      SELECT p.*, s.final_score as avg_score, ... FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE ${baseWhere} AND p.total_spaces >= 200
      ORDER BY p.total_spaces DESC LIMIT 10
    `))

    // 5. 헬 주차장 (hell tag 또는 score < 2.5)
    const hellRows = await db.all(sql.raw(`
      SELECT p.*, s.final_score as avg_score, ... FROM parking_lots p
      LEFT JOIN parking_lot_stats s ON s.parking_lot_id = p.id
      WHERE ${baseWhere} AND (p.curation_tag = 'hell' OR s.final_score < 2.5)
      ORDER BY s.final_score ASC LIMIT 10
    `))

    return { summary, easy, free, large, hell }
  })
```

---

## 4. 라우트 구조

```
src/routes/wiki/
├── index.tsx              (기존)
├── $slug.tsx              (기존 — 주차장 상세)
└── guides/
    ├── index.tsx           (신규 — 가이드 목록)
    └── $slug.tsx           (신규 — 지역 가이드 상세)
```

### 4.1 가이드 목록 (`/wiki/guides/index.tsx`)

```
┌──────────────────────────────────────┐
│  📍 지역별 주차 가이드               │
│  초보운전자를 위한 지역별 주차 정보   │
├──────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐          │
│  │ 서울     │  │ 경기     │  ...     │
│  │ 2,315개  │  │ 5,965개  │          │
│  │ 무료 23% │  │ 무료 35% │          │
│  └─────────┘  └─────────┘          │
│  (17개 지역 카드 그리드)             │
└──────────────────────────────────────┘
```

- 각 카드 클릭 → `/wiki/guides/{slug}`
- 카드에 지역명, 주차장 수, 무료 비율 표시

### 4.2 가이드 상세 (`/wiki/guides/$slug.tsx`)

```
┌──────────────────────────────────────┐
│  ← 가이드 목록                       │
│  서울 주차 가이드                     │
├──────────────────────────────────────┤
│  [주차장 2,315개] [무료 23%] [평균 45면]│ ← 요약 카드
├──────────────────────────────────────┤
│  😊 초보 추천 주차장                  │ ← RankingSection 재사용
│  1. XX 주차장  ⭐4.2               │
│  2. YY 주차장  ⭐3.8               │
├──────────────────────────────────────┤
│  🆓 무료 주차장 TOP                  │
│  1. ZZ 주차장  500면               │
├──────────────────────────────────────┤
│  🏢 넓은 주차장 TOP                  │
│  1. WW 주차장  1,200면             │
├──────────────────────────────────────┤
│  💀 헬 주차장 주의                   │
│  1. AA 주차장  ⭐1.8               │
└──────────────────────────────────────┘
```

- 위키 홈의 `RankingSection` + `RankingList` 컴포넌트를 공유 사용
- 각 주차장 클릭 → `/wiki/$slug` (기존 상세 페이지)

---

## 5. SEO

### 5.1 메타 태그 (`head` 함수)

```typescript
head: ({ loaderData }) => ({
  meta: [
    { title: `${region.name} 주차 가이드 — 초보운전 주차 쉬운 곳 | 쉬운주차장` },
    { name: 'description', content: `${region.name} 지역 주차장 ${summary.total}개 중 초보 추천, 무료, 넓은 주차장 정보` },
    { property: 'og:title', content: `${region.name} 주차 가이드 | 쉬운주차장` },
    { property: 'og:url', content: `https://easy-parking.xyz/wiki/guides/${slug}` },
  ],
})
```

### 5.2 위키 홈 → 가이드 링크

위키 홈(`/wiki/index.tsx`)에 "지역별 가이드" 섹션 또는 링크 추가.

---

## 6. 컴포넌트 공유

위키 홈의 `RankingSection`, `RankingList`를 별도 파일로 추출하여 재사용:

```
src/components/
└── wiki/
    └── RankingSection.tsx   ← 위키 홈 + 가이드 상세에서 공유
```

현재 `RankingSection`과 `RankingList`는 `/wiki/index.tsx` 안에 인라인 정의되어 있으므로, 파일 분리 필요.

---

## 7. Implementation Order

```
Step 1: src/lib/regions.ts 생성 (지역 코드 맵)
Step 2: src/components/wiki/RankingSection.tsx 추출 (위키 홈에서 분리)
Step 3: src/server/parking.ts에 fetchGuideList, fetchGuideDetail 추가
Step 4: src/routes/wiki/guides/index.tsx 생성 (가이드 목록)
Step 5: src/routes/wiki/guides/$slug.tsx 생성 (가이드 상세)
Step 6: src/routes/wiki/index.tsx에 가이드 링크 추가
Step 7: bun --bun run build 확인
```

---

## 8. Verification Checklist

- [ ] `/wiki/guides` 목록 페이지에 17개 지역 카드 표시
- [ ] `/wiki/guides/seoul` 등 상세 페이지에 4개 섹션 렌더링
- [ ] 각 주차장 카드 클릭 → `/wiki/$slug` 이동
- [ ] 데이터 없는 섹션은 숨김 (graceful degradation)
- [ ] SEO 메타 태그 확인
- [ ] `RankingSection` 공유 후 위키 홈 정상 동작
- [ ] `bun --bun run build` 성공
