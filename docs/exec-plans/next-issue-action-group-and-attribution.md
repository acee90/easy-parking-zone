# 후속 이슈: 액션 그룹 재배치 + 공공데이터 API 출처 표기

> 분리 출처: #115 Phase 8 + Phase 9
> 본 문서: 두 항목 모두 사이트 전반 정보 구조 결정이 필요하므로 별도 이슈로 분리하여 논의 후 진행

## 배경

이슈 #115 작업 중 다음 두 항목이 단일 상세 페이지 범위를 넘어 사이트 전반 IA(Information Architecture) 결정이 필요한 것으로 확인됨:

1. **길찾기 / up-down / bookmark / 전화** 액션 그룹 재배치 — 액션 우선순위·그룹화 결정 후 모든 surface(메인 카드, 상세, 모바일 시트)에 일관 적용 필요
2. **공공데이터 API 출처 표기** — wiki 상세에만 표시할지, 메인 지도/footer/about 등 어디에 둘지 사이트 전반 결정

---

## Section A — 액션 그룹 재배치 (구 Phase 9)

### 현재 상태

상세 페이지 (`src/routes/wiki/$slug.tsx` 267-289줄):

```
[길찾기] [VoteBookmarkBar(👍 👎)] [전화]
[reliabilityBadge]
```

문제:
- bookmark 액션이 `VoteBookmarkBar` 안에 없음 (이름과 달리 vote만 처리, bookmark UI 분리됨)
- 모바일에서 액션 영역이 평탄(flat)하게 배치, 우선순위 시각적 구분 없음
- 메인 페이지 `MobileBottomPanel`, `ParkingCard` 등 다른 surface와 일관성 부재

### 검토 옵션

| 옵션 | 설명 | 장점 | 단점 |
|---|---|---|---|
| A | 길찾기+전화 (primary) / up-down+bookmark (secondary) | 명확한 위계 | 영역 2개로 분할되어 공간 차지 |
| B | 길찾기 단독 hero / 보조 액션 묶음 | 최강 우선순위 | 전화/up-down 발견성 저하 |
| C | 모바일 sticky 액션 바 (#114 시도된 패턴) | 항상 노출 | 콘텐츠 영역 좁아짐 |
| D | 길찾기 hero + 행 단위 보조 (up-down·bookmark·전화) | hero 명확 + 보조 동등 | 행 폭 부담 |

### 결정 필요 사항

- 가장 중요한 액션은? (길찾기 vs up-down 피드백)
- 모바일/데스크톱에서 동일 그룹화 vs 분리?
- 메인 카드(`ParkingCard`)와 상세(`$slug.tsx`)의 액션 일관성 요구 수준?
- bookmark는 vote와 같은 그룹? 별도?

### 영향 범위

- `src/routes/wiki/$slug.tsx` — 헤더 액션 영역
- `src/components/MobileBottomPanel.tsx` — 모바일 시트
- `src/components/ParkingCard.tsx` — 메인 지도 카드
- `src/components/ParkingDetailPanel.tsx` — 데스크톱 상세 패널
- `src/components/VoteBookmarkBar.tsx` — 컴포넌트 자체 (bookmark 통합 여부)

### 진행 방식

1. 디자인 옵션 시안 (Figma 또는 텍스트 와이어프레임) 작성
2. 사용자(@junhee)와 옵션 선택
3. 단일 PR로 전 surface 동시 적용 (일관성 보장)

---

## Section B — 공공데이터 API 출처 표기 (구 Phase 8)

### 배경

공공데이터포털(data.go.kr) 이용허락 정책: <https://www.data.go.kr/ugs/selectPortalPolicyView.do>
- 출처 표시 의무 (위치는 자유)
- 본 서비스에서 사용하는 데이터: 주차장 위치/운영시간/요금/면수/전화번호 등 기본 정보

### 데이터가 노출되는 사용 맥락

| Surface | 노출되는 공공데이터 |
|---|---|
| 메인 지도 (`/`) | 위치 (마커, 클러스터) |
| 검색 결과 (`SearchBar`) | 이름, 주소 |
| 모바일 바텀시트 (`MobileBottomPanel`) | 카드 정보 |
| 상세 페이지 (`/wiki/$slug`) | 위치, 운영시간, 요금, 면수, 전화번호 — **가장 직접적** |

### 현재 사이트 구조 제약

- Footer 컴포넌트 없음
- `/about`, `/info` 등 정보 페이지 없음
- 메인은 풀스크린 지도 → footer 노출 어려움

### 검토 옵션

| 옵션 | 위치 | 장점 | 단점 |
|---|---|---|---|
| A | 전역 Footer 신설 | 표준 패턴, 일원화 | 메인 지도(풀스크린) 적용 불가, 신규 작업 |
| B | 별도 `/about` 페이지 | 깔끔, 약관/문의 통합 | 발견성 낮음 |
| C | 상세 페이지 기본 정보 섹션 하단 1줄 | 데이터 노출 맥락 직접 | 메인/검색은 미표시 |
| D | 메인 지도 우하단 작은 attribution | 지도 라이브러리 컨벤션 일치 | 작아서 눈에 잘 안 띔 |
| E | 햄버거 메뉴 안 정보 항목 | 비침습적 | 발견성 낮음 |

### 추천: C + D 조합 (최소) → 후속 B로 확장

**즉시 적용 (이 이슈 범위)**:
1. **C**: 상세 페이지 기본 정보 섹션 하단 1줄
   - 예: `출처: 공공데이터포털 (data.go.kr)` + 외부 링크
2. **D**: 메인 지도 우하단 attribution 라인
   - 네이버맵 attribution 옆 자연스럽게 배치
   - 예: `주차장 정보: 공공데이터포털`

**향후 별도 이슈 (B 확장)**:
- `/about` 페이지 신설 → 데이터 출처 전체 목록(공공데이터, 네이버 블로그/카페, YouTube, 클리앙 등) + 약관 + 개인정보처리방침 + 문의
- 햄버거 메뉴에 "정보" 진입점 추가

### 결정 필요 사항

- 즉시 적용은 C+D 조합으로 충분한가? B(`/about`)도 함께 진행?
- D(지도 attribution) 문구 톤: 간결("공공데이터포털") vs 명시("주차장 정보: 공공데이터포털")
- 다른 출처(네이버 블로그/카페, YouTube, 클리앙)도 같이 정리할 시점?

### 영향 범위

- `src/routes/wiki/$slug.tsx` — 기본 정보 섹션 하단
- `src/components/MapView.tsx` — 지도 attribution 영역
- (향후) `src/routes/about.tsx` — 신규 라우트
- (향후) Footer 컴포넌트 신설 시 layout 라우트 영향

### 법적 의무 검토

- 공공데이터포털 이용허락 표시 정책 정독 필요 (구체 문구·로고 규정)
- 위치 자유라 한 곳이라도 충족되면 무방
- 권장: 데이터 노출 맥락에 가까운 위치

---

## 우선순위 / 진행 순서 제안

1. **Section B 즉시 진행 (C+D 최소안)** — 법적 의무 측면, 작은 변경
2. **Section A 시안 작성 후 결정** — IA 결정 필요, 영향 범위 큼
3. **별도 후속 이슈**: Footer/`about` 페이지 신설, 다른 출처 정리

## 미해결 질문

- A의 옵션 4개 중 선호?
- B의 즉시 적용 범위(C만 / C+D / C+D+B)?
- 두 항목을 단일 PR로 묶을지, 분리할지?
