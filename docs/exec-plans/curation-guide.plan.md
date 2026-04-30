# 큐레이션 가이드 페이지 Planning Document

> **Summary**: 주차장 자체 데이터(난이도, 요금, 면수, 무료 여부)를 활용하여 지역별 주차 가이드 페이지를 자동 생성한다
>
> **Project**: easy-parking-zone
> **Version**: 0.1.0
> **Author**: junhee
> **Date**: 2026-04-07
> **Status**: Draft
> **GitHub Issue**: #80

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 위키 홈에서 전국 주차장을 탐색할 수 있지만, "서울에서 초보가 주차하기 좋은 곳" 같은 지역+조건별 니즈에 대한 진입점이 없다 |
| **Solution** | 주차장 데이터(난이도, 요금, 면수, 큐레이션 태그)를 지역별로 그룹핑하여 가이드 목록 + 상세 페이지를 자동 생성 |
| **Function/UX Effect** | `/wiki/guides`에서 지역별 가이드 카드 탐색 → `/wiki/guides/{slug}`에서 해당 지역 주차장 TOP 목록 확인 |
| **Core Value** | SEO 랜딩 페이지 역할 + 지역별 탐색 경험으로 서비스 발견성과 체류시간 향상 |

---

## 1. Overview

### 1.1 Purpose

주차장 자체 데이터를 지역별로 묶어 "지역별 주차 가이드" 페이지를 제공한다. nearby_places 데이터(현재 56건)에 의존하지 않고, 전체 34,719개 주차장 데이터를 활용한다.

### 1.2 Background

- 주차장 34,719개, curation_tag hell 95개 / easy 16개
- web_sources 재매칭 후 스코어가 구조적 기본값 중심으로 리셋됨 (Batch API 처리 후 복원 예정)
- 지역별 데이터는 충분: 경기 5,965개, 강원 2,885개, 서울 2,315개 등

### 1.3 Related Documents

- GitHub Issue: [#80](https://github.com/acee90/easy-parking-zone/issues/80)
- Parent Epic: [#77](https://github.com/acee90/easy-parking-zone/issues/77)
- M7 Report: [docs/archive/2026-04/M7-curation/](../archive/2026-04/M7-curation/)

---

## 2. Scope

### 2.1 In Scope

1. **가이드 목록 페이지** (`/wiki/guides`) — 지역별 카드 그리드
2. **가이드 상세 페이지** (`/wiki/guides/$slug`) — 해당 지역 주차장 TOP 리스트
3. **가이드 컨텐츠 구성**: 주차장 데이터 기반 자동 생성
   - 초보 추천 (easy tag 또는 score >= 3.5)
   - 주의 필요 (hell tag 또는 score < 2.5)
   - 무료 주차장
   - 넓은 주차장 (면수 200+)
4. **SEO**: JSON-LD, OG 메타, 시맨틱 HTML
5. **위키 홈 → 가이드 링크** 연결

### 2.2 Out of Scope

- 테마별 가이드 (카페 투어, 맛집 탐방 등) — nearby_places 데이터 부족
- 코스형 순서 추천 — 데이터 불충분
- 사용자 생성 가이드

---

## 3. Implementation Plan

### 3.1 지역 분류 체계

17개 광역시/도 기반:

```
서울, 부산, 대구, 인천, 광주, 대전, 울산, 세종,
경기, 강원, 충북, 충남, 전북, 전남, 경북, 경남, 제주
```

slug: `seoul`, `busan`, `gyeonggi`, `gangwon` 등

### 3.2 가이드 상세 페이지 섹션 구성

```
[지역명] 주차 가이드
├── 요약 카드 (전체 주차장 수, 무료 비율, 평균 면수)
├── 초보 추천 주차장 TOP (score >= 3.5 또는 easy tag)
├── 무료 주차장 TOP
├── 넓은 주차장 TOP (면수 기준)
└── 헬 주차장 주의 (score < 2.5 또는 hell tag)
```

### 3.3 라우트 구조

```
src/routes/wiki/
├── guides/
│   ├── index.tsx        — 가이드 목록 페이지
│   └── $slug.tsx        — 가이드 상세 페이지
```

### 3.4 데이터 로딩

서버 함수로 지역별 주차장 쿼리:

```typescript
// parking.ts에 추가
fetchGuideData({ region: 'seoul' })
→ { summary, easyLots, freeLots, largeLots, hellLots }
```

---

## 4. Risk Assessment

| Risk | Impact | Mitigation |
|------|--------|------------|
| 스코어 리셋으로 easy/hard 분류 부족 | 가이드 컨텐츠가 빈약 | curation_tag 기반 + 구조적 점수(면수, 무료) 활용, Batch 완료 후 스코어 복원 |
| 일부 지역 주차장 데이터 부족 | 세종(소수) 등 | 주차장 10개 미만 지역은 가이드 미생성 |
| 가이드 내용이 정적으로 느껴짐 | 재방문 유인 부족 | 스코어/웹소스 업데이트 시 자동 반영 (SSR) |

---

## 5. Verification

- [ ] `/wiki/guides` 목록 페이지 렌더링
- [ ] `/wiki/guides/seoul` 등 주요 지역 상세 페이지
- [ ] 각 섹션 데이터가 올바르게 쿼리되는지 확인
- [ ] SEO 메타 태그 (title, description, og:*)
- [ ] 위키 홈에서 가이드로 링크
- [ ] `bun --bun run build` 성공
