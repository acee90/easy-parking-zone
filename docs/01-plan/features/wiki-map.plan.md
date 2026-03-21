# Plan: wiki-map — 위키 상세 페이지 미니 지도

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 위키 상세 페이지에서 주차장 위치를 지도 없이 주소 텍스트로만 파악해야 함 |
| **Solution** | 기본정보 아래에 네이버 미니 지도를 인라인으로 표시, zoom 제한으로 주변 맥락 제공 |
| **Function/UX Effect** | 페이지 로드 시 주차장 위치를 시각적으로 즉시 확인, 별도 지도 앱 전환 불필요 |
| **Core Value** | 주차장 위치 파악 속도 향상 → 위키 페이지의 정보 완결성 강화 |

## 1. User Intent Discovery

### Core Problem
위키 상세 페이지에서 주차장 위치를 주소 텍스트로만 파악해야 하고, "지도에서 보기"를 누르면 메인 지도 페이지로 완전히 이탈함. 근처 주차장 리스트는 텍스트만으로 공간적 관계를 전달하지 못함.

### Target Users
- 위키 페이지를 통해 주차장 정보를 확인하는 사용자
- Google 검색으로 위키 페이지에 직접 진입한 사용자 (지도 탭을 안 본 상태)

### Success Criteria
- 위키 상세 페이지에서 주차장 위치를 지도로 즉시 확인 가능
- 근처 주차장 리스트 섹션 제거로 페이지 간결화

## 2. Scope

### In Scope
- `WikiMiniMap` 컴포넌트: react-naver-maps 인라인 지도
- 해당 주차장 강조 마커 1개 표시
- Zoom 제한: 초기 16, min 14 / max 18
- 인터랙션 비활성화 (드래그/줌/스크롤 제스처)
- 근처 주차장 리스트 섹션 제거

### Out of Scope (YAGNI)
- 근처 주차장 마커 표시
- 난이도 색상 마커
- 지도 인터랙션 (드래그, 줌)

## 3. Implementation

### 3.1 새 컴포넌트
- `src/components/WikiMiniMap.tsx`
  - react-naver-maps의 `NaverMap` + `Marker` 사용
  - props: `lat`, `lng`, `name`
  - 높이 250px, rounded-xl, border
  - `draggable: false`, `scrollWheel: false`, `keyboardShortcuts: false`
  - `minZoom: 14`, `maxZoom: 18`, `defaultZoom: 16`

### 3.2 수정 파일
- `src/routes/wiki/$slug.tsx`
  - 기본정보 섹션 아래에 `WikiMiniMap` 추가
  - 근처 주차장 섹션 + `NearbyCard` + `fetchNearbyParkingLots` 제거
  - "지도에서 보기" 버튼 유지

## 4. Alternatives Explored

| Approach | 장점 | 단점 | 결과 |
|----------|------|------|------|
| **네이버 지도 인라인** | 기존 코드 재사용, 마커 커스텀 가능 | JS 번들 크기 증가 | **선택** |
| Static Map API | 가벼움, 이미지 | 마커 클릭 불가, API 호출 비용 | 제외 |
| iframe 임베드 | 간단 | 커스터마이징 불가 | 제외 |

## 5. YAGNI Review

| 항목 | 포함 | 사유 |
|------|:----:|------|
| 해당 주차장 마커 | O | 핵심 기능 |
| Zoom 제한 | O | 사용자 요청 |
| 근처 주차장 마커 | X | 메인 지도에서 확인 가능, 미니맵에 불필요 |
| 난이도 색상 마커 | X | 마커 1개라 색상 불필요 |
| 드래그/줌 인터랙션 | X | 읽기 전용 목적 |
