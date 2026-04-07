# M7 초보운전 큐레이션 Planning Document

> **Summary**: 주차 쉬운 주차장(난이도 3.5+) 근처 갈만한 곳을 크롤링 데이터 기반으로 AI 추출하여 큐레이션 콘텐츠를 제공한다
>
> **Project**: easy-parking-zone
> **Version**: 0.1.0
> **Author**: junhee
> **Date**: 2026-04-03
> **Status**: Draft
> **Milestone**: M7: 초보운전 큐레이션

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 초보운전자가 주차 쉬운 곳을 찾더라도 "거기서 뭘 할 수 있는지" 알 수 없어 실제 방문으로 이어지지 않는다 |
| **Solution** | 기존 블로그 크롤링 데이터에서 AI로 주변 장소·방문 팁을 추출하고, 위키 페이지에 큐레이션 섹션을 추가한다 |
| **Function/UX Effect** | 위키 상세 페이지에서 "이 주차장 근처 갈만한 곳" 카드를 바로 확인 → 주차+목적지를 한번에 결정 |
| **Core Value** | "주차 쉬운 곳" 정보에서 "주차 쉬운 곳 + 갈만한 곳" 경험으로 확장하여 서비스 고착도를 높인다 |

---

## 1. Overview

### 1.1 Purpose

초보운전자를 위해 난이도 3.5+ 주차장 근처의 카페/맛집/관광지/공원 등을 크롤링 데이터 기반으로 자동 큐레이팅하여 위키 페이지에서 제공한다.

### 1.2 Background

**데이터 현황 (2026-04-03 기준):**
- 난이도 3.5+ 주차장: **349개**, 블로그 보유 **341개** (97.7%)
- 블로그 내 주변장소 키워드: 공원 210건, 맛집 204건, 시장 169건, 카페 114건
- 지역 분포: 경기 120, 경상 59, 전라 22, 충청 21, 강원 20, 서울 16, 인천 16 ...
- 기존 AI 필터 파이프라인(Haiku)이 이미 블로그 분류·요약을 수행 중

**기존 인프라 활용 가능:**
- `web_sources` 테이블에 블로그 텍스트 보유
- `ai-filter.ts`의 Haiku 기반 분류 파이프라인 패턴 재사용 가능
- `parking_lot_stats`로 난이도 필터링 가능

### 1.3 Related Documents

- GitHub Milestone: M7: 초보운전 큐레이션
- 위키 상세 페이지: `src/routes/wiki/$slug.tsx`
- AI 필터 모듈: `src/server/crawlers/lib/ai-filter.ts`
- 크롤링 파이프라인: [docs/poi-pipeline-v2.md](../../poi-pipeline-v2.md)

---

## 2. Scope

### 2.1 In Scope

**Phase A: 데이터 추출 + 위키 섹션**
- [ ] AI 추출: 블로그 텍스트에서 주변 장소명·카테고리·방문 팁 구조화
- [ ] `nearby_places` 테이블 설계 및 마이그레이션
- [ ] 위키 상세 페이지 "주변 갈만한 곳" 섹션 UI

**Phase B: 가이드 페이지 (후속)**
- [ ] `/wiki/guides/{region}-{theme}` 코스형 큐레이션 페이지
- [ ] 지역별 자동 가이드 생성 로직

### 2.2 Out of Scope

- 사용자 제보 기반 장소 추가 (M3 인터랙션 강화 범위)
- 실시간 영업시간 확인 (외부 API 의존)
- 네이버 플레이스/카카오맵 직접 크롤링 (ToS 리스크, #17)
- 사진 크롤링 (#76, 별도 이슈)

---

## 3. Requirements

### 3.1 Functional Requirements

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-01 | 블로그 텍스트에서 주변 장소(이름, 카테고리, 한줄 설명)를 AI로 추출 | P0 |
| FR-02 | 추출 결과를 `nearby_places` 테이블에 저장 | P0 |
| FR-03 | 위키 상세 페이지에 "주변 갈만한 곳" 섹션 표시 | P0 |
| FR-04 | 장소 카테고리별 아이콘/필터 (카페, 맛집, 공원, 관광) | P1 |
| FR-05 | 블로그 출처 링크 표시 | P1 |
| FR-06 | 방문 팁 표시 (추천 시간대, 요일, 계절 등) | P2 |
| FR-07 | 지역별 가이드 페이지 자동 생성 | P2 |

### 3.2 Non-Functional Requirements

| ID | Requirement |
|----|-------------|
| NFR-01 | AI 추출 비용: Haiku 사용, 블로그당 ~$0.001 이하 (341건 = ~$0.34) |
| NFR-02 | 추출 정확도: 장소명 80%+ 정확도 (수동 검수 샘플 기준) |
| NFR-03 | 위키 페이지 로딩: 기존 대비 +100ms 이내 |

---

## 4. Technical Approach

### 4.1 AI 추출 파이프라인

기존 `ai-filter.ts` 패턴을 확장:

```
web_sources (블로그 텍스트)
  ↓ Haiku API (배치)
  ↓ JSON 응답: {places: [{name, category, tip}]}
  ↓ nearby_places 테이블 INSERT
```

**프롬프트 설계 (예시):**
```
주차장 "{parking_name}" 근처 블로그 글에서 주변 장소를 추출하세요.
출력: {places: [{name: "장소명", category: "cafe|restaurant|park|tourist|market|etc", tip: "한줄 팁"}]}
```

### 4.2 DB 스키마

```sql
CREATE TABLE nearby_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  name TEXT NOT NULL,           -- 장소명
  category TEXT NOT NULL,       -- cafe, restaurant, park, tourist, market, etc
  tip TEXT,                     -- 방문 팁 (시간대, 추천 메뉴 등)
  source_blog_id INTEGER REFERENCES web_sources(id),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX idx_nearby_parking ON nearby_places(parking_lot_id);
```

### 4.3 UI 구조

위키 상세 페이지(`$slug.tsx`)의 미니맵과 탭 사이에 섹션 추가:
```
[기본 정보] → [미니 지도] → [주변 갈만한 곳 ★NEW] → [리뷰/블로그/영상 탭]
```

---

## 5. Implementation Plan

### Phase A: 데이터 추출 + 위키 섹션 (이슈 2개)

| Step | Task | Size | 의존 |
|------|------|------|------|
| A-1 | AI 추출 스크립트 + nearby_places 테이블 | M | - |
| A-2 | 위키 상세 "주변 갈만한 곳" 섹션 UI | S | A-1 |

### Phase B: 가이드 페이지 (이슈 1개, 후속)

| Step | Task | Size | 의존 |
|------|------|------|------|
| B-1 | `/wiki/guides/` 코스형 가이드 페이지 | L | A-1 |

---

## 6. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| AI 추출 정확도 낮음 | 엉뚱한 장소 표시 | 카테고리 confidence 필터 + 2개 이상 블로그에서 언급된 장소만 표시 |
| 블로그 내용에 장소 정보 없음 | 빈 섹션 | 장소 0건이면 섹션 숨김 |
| Haiku API 비용 | 월 비용 증가 | 1회성 배치, 신규 블로그만 incremental |

---

## 7. Success Metrics

| Metric | Target |
|--------|--------|
| 주변 장소 추출 주차장 수 | 200개+ (전체 349개 중 57%+) |
| 주차장당 평균 추출 장소 수 | 2개+ |
| 위키 페이지 "주변 갈만한 곳" 클릭률 | 측정 시작 (추후 목표 설정) |
