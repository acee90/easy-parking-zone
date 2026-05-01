# Desktop Map Panel — List ↔ Detail Slide

> 작성일: 2026-05-01
> PRs: #120, #121

데스크톱 지도 페이지(`/`)의 좌측 island를 단일 패널로 통합하고, iOS 네비게이션
컨트롤러 스타일의 push/pop 슬라이드로 List ↔ Detail 뷰를 전환하는 패턴.

## 배경 / 문제 정의

이전 디자인은 사이드바(280px) + 상세 패널(400px) + gap이 동시에 표시되어
좌측 약 700px가 지도를 가렸다. 사용자 피드백:
> 패널이 하나 더 뜨니까 공간을 너무 많이 잡아먹는 것 같다.

다른 서비스(네이버/카카오/Google Maps/Yelp/Zillow) 모두 단일 패널 안에서
list와 detail이 한 번에 하나씩만 표시되는 패턴을 사용한다.

## 솔루션

### 컨테이너 구조

```
DesktopMapPanel (360px 고정 폭, 좌측 island)
├─ Persistent header (h-12, border-b)
│   └─ AnimatePresence mode="wait" (cross-fade 150ms)
│       ├─ list 모드: ParkingSquare + "주차장 목록" + 개수
│       └─ detail 모드: ◀ "목록" 뒤로가기 버튼
└─ Body (flex-1, overflow-hidden, relative)
    └─ AnimatePresence mode="sync" (slide 250ms cubic-bezier 0.16,1,0.3,1)
        ├─ list 뷰 (absolute inset-0): ParkingSidebar
        └─ detail 뷰 (absolute inset-0): ParkingDetailPanel
```

### 슬라이드 방향 (iOS push 표준)

| 액션 | List 변화 | Detail 변화 |
|---|---|---|
| 진입 (push) | x: 0 → -100% (왼쪽으로 빠짐) | x: 100% → 0 (오른쪽에서 들어옴) |
| 복귀 (pop) | x: -100% → 0 (왼쪽에서 들어옴) | x: 0 → 100% (오른쪽으로 빠짐) |

`mode="sync"`로 둘이 동시에 진행되며 화면 중앙에서 자연스럽게 cross.
이전엔 `mode="wait"`였는데 exit가 끝나야 enter가 시작되어 빈 공백이 보였음.

### 인터랙션 모델 (highlight-first)

```
┌──────────────────┐    첫 클릭     ┌──────────────────┐    재클릭     ┌──────────────────┐
│ List              │ ─────────────▶│ List + selected   │ ────────────▶│ Detail (slide)   │
│ (선택 없음)        │    (highlight  │ (chevron 아이콘)  │   (push)      │                  │
└──────────────────┘     + 지도 센터)└──────────────────┘               └────────┬─────────┘
                                                              ◀ 또는 ESC          │
                                       ◀──────────────────────────────────────────┘
                                                  (pop, selectedLot 유지)
```

- **첫 클릭** (사이드바/마커): 해당 항목 highlight + 지도 센터로 이동. **디테일 띄우지 않음.**
- **재클릭** (같은 항목): detail로 push 슬라이드.
- **chevron 어포던스**: 선택된 사이드바 항목 우측에 `ChevronRight` (텍스트 없이) — "재클릭하면 더 볼 수 있다"는 시각 단서.
- **검색 / deep link**: 명시적 의도이므로 detail 직행 (`?lotId=`, 헤더 검색).
- **◀ "목록" / ESC**: detail에서 list로 pop. `selectedLot`은 유지되어 직전 항목이 여전히 highlight.

### 상태 모델

```ts
const [selectedLot, setSelectedLot] = useState<ParkingLot | null>(null)
const [viewMode, setViewMode] = useState<'list' | 'detail'>('list')

const handleSidebarSelect = (lot: ParkingLot) => {
  setMoveTo({ lat: lot.lat, lng: lot.lng })
  if (selectedLot?.id === lot.id) setViewMode('detail')  // 재클릭 → push
  else setSelectedLot(lot)                                // 첫 클릭 → highlight
}
```

- `selectedLot` — highlight 대상. 데스크톱/모바일 공유.
- `viewMode` — 데스크톱 슬라이드 토글 전용. 모바일은 무시.
- 모바일(`MobileBottomPanel` + `ParkingCard`)은 기존 동작 유지: `selectedLot != null`이면 `ParkingCard` 자동 노출.

### 접근성

- **ESC 단축키**로 detail → list pop.
- **`prefers-reduced-motion: reduce`** 자동 대응 (`useReducedMotion()`).
- `aria-label` — 사이드바 항목은 선택 상태에 따라 동적 라벨 (`{name} 선택` / `{name} 자세히 보기`).

### 레이아웃 영향

- 좌측 island 폭: **700px → 360px** (지도 가시 영역 +340px).
- 필터 좌측 오프셋: 단일값 380px로 고정 (`selectedLot` 분기 제거).

## 의존성

- `motion@12.38.0` (Framer Motion v12 리브랜드, `motion/react`로 import).
- 클라이언트 번들 ~30~40KB gzipped 증가.

## 관련 파일

- `src/components/DesktopMapPanel.tsx` — 통합 컨테이너 (헤더 + 슬라이드 컨테이너)
- `src/components/ParkingSidebar.tsx` — list 뷰 본문
- `src/components/ParkingDetailPanel.tsx` — detail 뷰 본문
- `src/routes/index.tsx` — 상태 관리 + 핸들러

## 의사결정 기록

| 항목 | 선택 | 대안 |
|---|---|---|
| 통합 패널 폭 | 360px | 400 (Detail 친화) / 320 (Sidebar 친화) / 동적 |
| 슬라이드 모드 | `mode="sync"` (동시) | `mode="wait"` (순차) — 빈 공백 발생 |
| 헤더 처리 | persistent header + body-only slide | 전체 슬라이드 — 헤더가 사라졌다 다시 나타남 |
| 첫 클릭 동작 | highlight + center | 즉시 detail push — 공간 너무 빨리 가림 |
| 재클릭 어포던스 | ChevronRight 아이콘 | 더블클릭 / 별도 "자세히" 버튼 / 인포카드 |
| 검색/deep link | detail 직행 | highlight만 — 사용자 의도와 mismatch |
| 정렬 토글 | 제거 (거리순 고정) | 유지 — 사용 빈도 낮고 공간 차지 |
| 애니메이션 라이브러리 | `motion` (Framer Motion v12) | GSAP / 직접 CSS — `<AnimatePresence>` 패턴이 push/pop에 정확히 맞음 |

## 참고

- iOS Human Interface Guidelines — Navigation
- 네이버 지도 / 카카오맵 모바일 패턴
- Yelp / Zillow / Airbnb 데스크톱 검색 결과 페이지
