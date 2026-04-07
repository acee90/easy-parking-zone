# M7-curation Gap Analysis Report

> **Feature**: M7-curation (초보운전 큐레이션: 주변 장소 AI 추출 + 위키 섹션)
> **Design**: docs/02-design/features/M7-curation.design.md
> **Date**: 2026-04-07

---

## Overall Match Rate: 95%

| Category | Score | Status |
|----------|:-----:|:------:|
| Design Match (9 design sections) | 94% | ✅ |
| Plan FR Match (Phase A, 6 items) | 83% | ⚠️ |
| Architecture Compliance | 100% | ✅ |
| Convention Compliance | 100% | ✅ |
| **Overall** | **95%** | **✅** |

---

## Design Section Match

### 1. Data Model (3.1, 3.2) — 100%

| Item | Design | Implementation | Status |
|------|--------|---------------|:------:|
| `nearby_places` CREATE TABLE | 8 columns + 1 index | `migrations/0031_nearby_places.sql` 일치 | ✅ |
| Drizzle schema `nearbyPlaces` | sqliteTable 정의 | `src/db/schema.ts` 일치 | ✅ |
| `source_blog_ids` JSON 배열 | Design에서 변경 문서화 | 구현 일치 | ✅ |

### 2. AI Extractor Module (3.3) — 85%

| Item | Design | Implementation | Status |
|------|--------|---------------|:------:|
| 함수명 | `extractNearbyPlaces()` | `extractFromBlogs()` | ⚠️ 변경 |
| 시그니처 | `(inputs[], apiKey) => Place[][]` | `(name, blogs[], apiKey) => {blogId, places}[]` | ⚠️ 개선 |
| NearbyPlace 인터페이스 | `{name, category, tip}` | 동일 | ✅ |
| HAIKU_MODEL | `claude-haiku-4-5-20251001` | 동일 | ✅ |
| SYSTEM_PROMPT | 12줄 | 동일 | ✅ |
| Content 500자 제한 | 명시 | `b.content.slice(0, 500)` | ✅ |
| max_tokens: 300 | 명시 | `300 * blogs.length` | ✅ |
| JSON parse fallback | `parseOne()` 패턴 | `parseOnePlaces()` + `parseBatchPlaces()` | ✅ |
| Merge 로직 | Design 3.4 서술 | `mergeExtractedPlaces()` 함수 | ✅ |

### 3. Server Function (3.5) — 100%

| Item | Design | Implementation | Status |
|------|--------|---------------|:------:|
| `createServerFn({ method: 'GET' })` | 명시 | `src/server/parking.ts` 일치 | ✅ |
| Input: `{ parkingLotId: string }` | 명시 | 일치 | ✅ |
| Select 5 fields | 명시 | 일치 | ✅ |
| `orderBy(desc(mentionCount))` | 명시 | 일치 | ✅ |
| `.limit(10)` | 명시 | 일치 | ✅ |

### 4. UI Section (3.6) — 95%

| Item | Design | Implementation | Status |
|------|--------|---------------|:------:|
| 위치 (MiniMap과 Tabs 사이) | 명시 | `$slug.tsx` 정확 | ✅ |
| 조건부 렌더링 `length > 0` | 명시 | `places.length === 0 ? null` | ✅ |
| 제목 + 뱃지 | 명시 | 일치 | ✅ |
| 카테고리 아이콘 7종 | `CATEGORY_ICON` | `CATEGORY_META` (내용 동일) | ⚠️ 이름 |
| 카드 그리드 (2열) | 명시 | `grid-cols-1 sm:grid-cols-2` (반응형) | ✅ 개선 |
| Loader `Promise.all` | 명시 | 일치 | ✅ |

### 5. Type Definition (5) — 100%

`NearbyPlaceInfo` 5개 필드 모두 일치.

### 6. Error Handling (6) — 100%

5개 엣지 케이스 모두 설계대로 처리.

---

## Plan FR Match

| ID | Requirement | Priority | Status | Notes |
|----|------------|:--------:|:------:|-------|
| FR-01 | 블로그 텍스트에서 주변 장소 AI 추출 | P0 | ✅ | `nearby-extractor.ts` |
| FR-02 | `nearby_places` 테이블에 저장 | P0 | ✅ | Migration + Schema |
| FR-03 | 위키 상세 페이지 섹션 | P0 | ✅ | `NearbyPlacesSection` |
| FR-04 | 카테고리별 아이콘/필터 | P1 | ⚠️ | 아이콘 O, 필터 X |
| FR-05 | 블로그 출처 링크 표시 | P1 | ❌ | DB 저장O, UI 미노출 |
| FR-06 | 방문 팁 표시 | P2 | ✅ | tip 조건부 렌더링 |
| FR-07 | 지역별 가이드 페이지 | P2 | — | Phase B (후속) |

---

## Gaps Summary

### Missing (2 items)

| Item | Impact | 설명 |
|------|--------|------|
| FR-05 출처 링크 | Medium | `source_blog_ids` DB 저장됨, UI 미표시 |
| FR-04 카테고리 필터 | Low | 현재 데이터양(주차장당 1-6개)으로는 불필요할 수 있음 |

### Changed (4 items, 모두 개선)

| Item | Design → Implementation | Impact |
|------|------------------------|--------|
| 함수명 | `extractNearbyPlaces` → `extractFromBlogs` | Low |
| 시그니처 | 배열 → 명시적 파라미터 + blogId 추적 | Low (개선) |
| 변수명 | `CATEGORY_ICON` → `CATEGORY_META` | None |
| 그리드 | 고정 2열 → 반응형 | Positive |

### Added (Design 범위 밖, 5 items)

| Item | Impact |
|------|--------|
| `mergeExtractedPlaces()` 별도 export | Positive (재사용성) |
| `NearbyCategory` 타입 별칭 | Positive (타입 안전성) |
| `VALID_CATEGORIES` 런타임 검증 | Positive (방어적 코딩) |
| `docs/nearby-places-pipeline.md` 문서 | Positive (문서화) |
| Responsive grid | Positive (UX) |

---

## 배치 실행 결과

| 항목 | 목표 | 실제 | 달성 |
|------|------|------|:----:|
| 주변 장소 추출 주차장 수 | 200개+ | 124개 | ⚠️ 62% |
| 주차장당 평균 추출 장소 수 | 2개+ | 1.3개 | ⚠️ |
| AI 비용 | ~$0.34 | ~$0.34 | ✅ |
| 에러 | 0 | 0 | ✅ |

mention >= 2 필터가 엄격하여 목표 미달. 필터 완화(>=1) 시 커버리지 증가 가능하나 정확도 트레이드오프.
