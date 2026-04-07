# M7-curation Completion Report

> **Project**: easy-parking-zone
> **Feature**: M7 초보운전 큐레이션 — 주변 장소 AI 추출 + 위키 섹션
> **Author**: junhee
> **Date**: 2026-04-07
> **PDCA Duration**: 2026-04-03 ~ 2026-04-07

---

## Executive Summary

| Item | Value |
|------|-------|
| **Feature** | M7 초보운전 큐레이션: 주차 쉬운 곳 + 주변 갈만한 곳 |
| **Start Date** | 2026-04-03 |
| **Completion Date** | 2026-04-07 |
| **Duration** | 5 days (2 sessions) |
| **Match Rate** | 95% |
| **Gap Items** | 15 total (11 match, 4 changed/improved, 0 critical missing) |
| **Files Changed** | 7 new + 3 modified |
| **Lines Added** | ~926 |
| **Tests** | 127/127 passed |

### Value Delivered

| Perspective | Content |
|-------------|---------|
| **Problem** | 초보운전자가 주차 쉬운 곳을 찾더라도 "거기서 뭘 할 수 있는지" 알 수 없어 방문으로 이어지지 않았다 |
| **Solution** | 기존 블로그 341건에서 Haiku AI로 주변 장소 추출, 124개 주차장에 167개 장소 큐레이션 데이터 생성 |
| **Function/UX Effect** | 위키 상세 페이지에서 "주변 갈만한 곳" 카드를 바로 확인 — 카테고리 아이콘, 방문 팁, 추천 횟수 표시 |
| **Core Value** | "주차 쉬운 곳" → "주차 쉬운 곳 + 갈만한 곳" 경험 확장으로 서비스 차별화 및 고착도 향상 |

---

## 1. PDCA Phase Summary

### 1.1 Plan

- 아이디어 발굴: 블로그 데이터에 카페/맛집/공원 언급이 풍부한 점 발견
- 데이터 실현 가능성 검증: D1 쿼리로 349개 주차장, 341개 블로그 보유 확인
- GitHub Milestone M7 생성 + Epic #77 + 하위 이슈 #78, #79, #80
- **Document**: `docs/01-plan/features/M7-curation.plan.md`

### 1.2 Design

- `ai-filter.ts` 패턴 재사용 설계
- `nearby_places` 스키마: `source_blog_id` → `source_blog_ids` JSON 배열로 변경
- `mention_count >= 2` 정확도 필터 설계
- 위키 UI: 미니맵과 탭 사이 위치, 조건부 렌더링
- **Document**: `docs/02-design/features/M7-curation.design.md`

### 1.3 Do

**구현 파일 (7개 신규 + 3개 수정)**:

| File | Role | Lines |
|------|------|------:|
| `migrations/0031_nearby_places.sql` | 테이블 생성 | 10 |
| `src/db/schema.ts` | Drizzle 스키마 추가 | +21 |
| `src/server/crawlers/lib/nearby-extractor.ts` | AI 추출 모듈 | 163 |
| `scripts/extract-nearby-places.ts` | 배치 스크립트 (1회성, 삭제됨) | 138 |
| `src/types/parking.ts` | NearbyPlaceInfo 타입 | +8 |
| `src/server/parking.ts` | fetchNearbyPlaces API | +28 |
| `src/routes/wiki/$slug.tsx` | NearbyPlaces UI 섹션 | +65 |
| `docs/nearby-places-pipeline.md` | 파이프라인 로직 문서 | 184 |
| `CLAUDE.md` | 참조 링크 추가 | +1 |

**배치 실행 결과**:

| 항목 | 수치 |
|------|------|
| 대상 주차장 | 341개 (score >= 3.5) |
| 저장된 장소 | **167개** |
| 커버된 주차장 | **124개** (35.5%) |
| 에러 | 0건 |
| 카테고리 분포 | 맛집 58, 관광 32, 공원 27, 시장 17, 기타 17, 카페 15, 병원 1 |
| AI 비용 | ~$0.34 (Haiku) |

**데이터 품질 검증**:
- 정릉시장 "기차순대국" — 블로그 5건+ 실제 맛집 확인
- 1913송정역시장 — 6건 언급, 시장 이용시 1시간 무료 정보 포함
- 수성못 "열무밭에돈" — 블로그 확인, 실제 맛집

### 1.4 Check (Gap Analysis)

| Category | Score |
|----------|:-----:|
| Design Match | 94% |
| Plan FR Match (Phase A) | 83% |
| Architecture Compliance | 100% |
| Convention Compliance | 100% |
| **Overall** | **95%** |

**Key Findings**:
- P0 요구사항 3개: 100% 충족
- 변경 4건: 모두 설계 대비 개선 (함수 시그니처, 반응형 그리드 등)
- 추가 5건: 모두 긍정적 (타입 안전성, 런타임 검증, 문서화 등)

**미완 2건 (P1, 후속 작업)**:
- FR-05 블로그 출처 링크 UI 미표시 (DB 데이터 있음)
- FR-04 카테고리 필터 UI (현재 데이터양으로는 불필요)

---

## 2. Commits

| Hash | Message |
|------|---------|
| `c060729` | M7 초보운전 큐레이션: 주변 장소 AI 추출 + 위키 섹션 (#78, #79) |
| `fda7154` | 주변 장소 AI 추출 파이프라인 로직 문서 추가 |
| `cc5946e` | 1회성 스크립트 제거: extract-nearby-places.ts |
| `765cca1` | M7 큐레이션 Gap 분석: Match Rate 95% |

---

## 3. GitHub Issues

| # | Title | Status |
|---|-------|--------|
| #77 | [Epic] 초보운전 큐레이션 | Open |
| #78 | AI 추출: 블로그에서 주변 장소·방문 팁 구조화 | Done |
| #79 | 위키 상세 "주변 갈만한 곳" 섹션 UI | Done |
| #80 | 큐레이션 가이드 페이지: 지역별 코스형 추천 | Todo (Phase B) |

---

## 4. Lessons Learned

### What Worked Well

1. **기존 인프라 재사용**: `ai-filter.ts` 패턴을 그대로 따라 `nearby-extractor.ts`를 빠르게 구현
2. **mention_count >= 2 필터**: 노이즈를 효과적으로 제거하여 높은 정확도 달성
3. **데이터 검증 선행**: dry-run + D1 쿼리로 블로그 원본 대조 후 본 배치 실행
4. **1회성 스크립트 관리**: 배치 완료 후 즉시 삭제하여 코드베이스 클린 유지

### What Could Be Improved

1. **커버리지**: 124/349 = 35.5%로 목표(200+) 미달. mention >= 1로 완화하면 증가하나 정확도 트레이드오프
2. **카테고리 편중**: 맛집 58개(35%)로 편중. 카페/공원 비중 늘리는 프롬프트 튜닝 가능
3. **incremental 처리**: 신규 블로그 추가 시 자동 추출하는 cron 파이프라인 미구축 (현재 1회성)

---

## 5. Next Steps

| Action | Priority | Issue |
|--------|----------|-------|
| Phase B: 지역별 가이드 페이지 | P2 | #80 |
| FR-05: 출처 링크 UI | P1 | 신규 |
| incremental 추출 cron | P2 | 신규 |
| mention >= 1 실험 | P3 | — |
