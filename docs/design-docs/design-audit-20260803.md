# 디자인 감사 리포트 (2026-08-03)

> 리디자인 사전 분석. 라이브(easy-parking.xyz) 시각 감사 + 코드 정량 감사(src/components/**, src/routes/** admin 제외).
> 전제: DAU ~2,500, **UX(화면 구조·동선)는 유지**하고 표면 품질만 올린다.
> 실행 계획: [visual-refresh.plan.md](../exec-plans/visual-refresh.plan.md)

## 결론: "AI가 만든 티"의 근본 원인 5가지

개별 컴포넌트의 문제가 아니라 **시스템 부재**가 원인. 골격(정보 구조, SEO, 접근성 일부, 바텀시트 구현)은 튼튼하고 표면만 기본값인 상태.

1. **디자인 토큰이 shadcn zinc 기본값 그대로** — `styles.css`의 `--primary`는 검정(zinc-950)인데 실제 브랜드 컬러는 `blue-500`으로 106회 하드코딩. 토큰이 실제 디자인을 표현하지 못해 개발자가 토큰을 우회 → 팔레트 직접 사용 475회 vs 시맨틱 토큰 298회.
2. **한글 폰트 미로드** — `@font-face`/웹폰트 로드 0건. 시스템 폰트 스택만 있어 Windows에선 맑은 고딕으로 렌더. 플랫폼마다 완전히 다른 인상.
3. **카드 스타일 수제 복제 5종+** — shadcn `Card` 사용 0회. `rounded-lg/xl/2xl/3xl` × `shadow 없음/xs/sm/md` 자유 조합. 같은 상세 페이지 안에서 점수 카드 `rounded-lg`, FAQ `rounded-xl`, 리뷰 `rounded-2xl`.
4. **액센트 컬러 6계열 난립** — blue(액션)+yellow(별점)+green/emerald(무료·추천)+red(위험)+orange/amber(난이도). 리뷰 폼만 노란 그라디언트 테마. 중립색도 gray(128회)와 zinc(140회) 병용.
5. **인터랙션 상태 미설계** — hover 146회 vs **active 5회, focus-visible(앱 코드) 1회**. 모바일 전용 컴포넌트(`MobileFilterSheet`)조차 hover만 존재.

## 사용자 지적 페이지 진단

### 둘러보기 (`/wiki`)
- 모든 섹션이 "흰 카드 + 회색 border" 단일 표면 → 추천 카드/랭킹 리스트/안내 박스의 시각적 구분 없음.
- 색은 상태 점(green/yellow/orange/red)과 노란 별뿐인데 규칙 없이 산재. 카드 제목 전부 `...` 잘림.
- 파란 이벤트 배너(`bg-blue-50`)만 유색이라 페이지에서 떠 보임.

### 주차장 상세 (`/wiki/$slug`)
- 데이터 없는 lot에서 리뷰 0·영상 없음·후기 없음 섹션이 회색 한 줄 텍스트로 노출 → **페이지 절반이 빈 상태**.
- 빈 상태 품질 3단계로 갈림: 리뷰 탭(`$slug.reviews.tsx:112-127`, 아이콘+제목+CTA) > 사이드바 > 인라인 섹션(`MediaSection.tsx:71` 등, text-xs 한 줄).
- FAQ 4개가 동일 카드 나열, "내 평가 남기기"만 노란 테마로 이질적.

## 정량 측정 요약

```
팔레트 직접 사용 475 vs 시맨틱 토큰 298 (팔레트 61%)
bg-white 100회 vs bg-card 1회
zinc 140 / gray 128 / blue 106 / yellow 43 / green 26 / red 21 / 기타 소수
hover: 146 / focus: 27 / focus-visible: 15(11회는 ui/ 내부) / active: 5
text-sm 162 / text-xs 106 / text-base 36 → 텍스트 ~65%가 14px 이하
text-[10px] 13회 + text-[11px] 6회 (한글 자소 뭉갬)
스켈레톤 0개, animate-pulse 1개
motion(framer) 실사용 1파일 (DesktopMapPanel)
```

## 항목별 상세

### 1. 타이포그래피 — 심각도 높음
- 커스텀 폰트 전무 (`styles.css:8-12` 시스템 스택). `code` 스택만 CRA 잔재로 존재.
- `tracking-normal`이 10곳에 명시돼 있으나 Tailwind 기본값이라 **no-op** (`ParkingCard.tsx:267`, `ParkingDetailPanel.tsx:92`, `$slug.index.tsx:135`, `SectionTitle.tsx:24` 등). 실제 `tracking-tight`는 `LegalShell.tsx:15` 1곳.
- 12px 미만 19곳. `MobileBottomPanel.tsx:149`의 "주의"는 위험 신호인데 가장 작은 글자.
- 잘 된 점: `tabular-nums` 의도적 사용(`MobileBottomPanel.tsx:158,176`, `RankingSection.tsx:162-190` 등), 한글 본문 `leading-relaxed` 일관.

### 2. 색상 — 심각도 높음
- 브랜드 블루가 토큰 밖: `--primary`=검정 vs `theme-color`/manifest/favicon.svg=`#3b82f6`. `bg-primary`(검정 새로고침 버튼, `index.tsx:257`)와 `bg-blue-500`(길찾기, `NavigationButton.tsx:94`)이 공존.
- gray/zinc 혼용: `ParkingCard.tsx` 한 파일에 `bg-gray-300`(228)/`hover:bg-gray-100`(233)/`text-zinc-900`(331)/`border-zinc-300`(368).
- 다크모드 변수 전부 정의돼 있으나 앱 코드 `dark:` 0회, 토글 없음 → 죽은 코드.
- 그라디언트 v3/v4 문법 혼용 (`bg-linear-to-r` vs `bg-gradient-to-br`).
- 토큰 버그: `--destructive-foreground`가 destructive와 동일한 빨강 (`styles.css:36`).
- 잘 된 점: 난이도 색상 `getDifficultyColor()`(`geo-utils.ts:32-40`) 중앙화 시도, `text-muted-foreground` 178회 일관.

### 3. 인터랙션 상태 — 심각도 높음
- `active:` 전체 5회. `FloatingFilters`/`MobileFilterSheet`/`ParkingSidebar`/`RankingSection`/wiki 지역 탭에 0개. 터치 기기에서 sticky hover 버그 유발.
- `focus-visible:` 앱 코드 1개(`StarRatingInput.tsx:42`). 커스텀 버튼 수십 개가 브라우저 기본 outline 의존.
- `ParkingCard.tsx:233` `outline-none focus:outline-none` 대체 스타일 없이 제거.
- `--ring: oklch(0.871 …)`(shadcn 기본 0.705보다 밝음) + `ring-ring/50` → 실효 대비 ~1.1:1, WCAG 2.4.11(3:1) 미달.

### 4. 로딩/빈/에러 — 심각도 중간
- 스켈레톤 0. 카드가 고정 크기(`UserReviewCard` h-[228px], `MediaCard` aspect-video)라 적용 최적 구조인데 스피너만 사용 → CLS.
- `ReviewSection.tsx:34-42` loading state 없음 → fetch 중 "아직 리뷰가 없습니다" 플래시.
- `.catch(() => {})` 광범위 (`ParkingCard.tsx:111`, `VoteBookmarkBar.tsx:17` 등 10+곳) → 네트워크 실패가 "데이터 없음"과 구분 불가.
- raw error message 노출: `MapErrorBoundary.tsx:30,37`, `ReviewForm.tsx:58,101` 등.

### 5. 레이아웃 — 심각도 중간
- `h-dvh`는 지도 1곳뿐, 나머지 12페이지 `min-h-screen`.
- safe-area 적용 2곳뿐. **`MobileBottomPanel.tsx:69`(모바일 메인 UI)에 누락** — iPhone 홈 인디케이터 겹침. `MapView.tsx:394`/`Footer.tsx:17`은 매직넘버로 회피.
- max-width 6종 혼재. 같은 lot의 탭 간 폭 점프: 상세 max-w-6xl → 리뷰 max-w-5xl → 영상 max-w-6xl.
- 모바일 바텀시트 2종 중복(`MobileBottomPanel` 자체구현 vs `ParkingCard` Radix Sheet), 스와이프 임계값 40px vs 120px.

### 6. 컴포넌트 패턴 — 심각도 중간~높음
- `Button` 앱 코드 미사용 — 매번 수제 (`index.tsx:255-262` = default variant 재현, `MapErrorBoundary.tsx:41` 동일 문자열 중복, `ReportDialog.tsx:122` red-500 수제 destructive).
- pill/뱃지 수제 다수: 같은 "무료" 뱃지가 `ParkingCard.tsx:250`(Badge)과 `RankingSection.tsx:108`(수제 회색 pill)에서 다르게 보임.
- 필터 UI 데스크톱/모바일 완전 이중 구현 + 상수 복붙 라벨 분기 (`'요금 전체'` vs `'전체'`, `'50면+'` vs `'50면 이상만'`).
- **난이도 색상 3중 정의** — `geo-utils.ts:32-40`(6단계) vs `ParkingSidebar.tsx:20-26`(5단계, 임계값·색 다름) vs `MapView.tsx:44-52`(hex). **같은 lot이 사이드바 노란 점, 지도 회색 점 가능 — 정합성 버그. 심각도 높음.**
- 잘 된 점: `Badge` variant 의미적 매핑, `Carousel` Context 분리 설계(최고 품질), `SectionTitle`/`LegalShell` 추상화.

### 7. 콘텐츠/카피 — 심각도 낮음~중간
- 전반 톤 차분·존댓말 일관. `parking-display.ts` `NO_INFO` 중앙화 잘 됨.
- 느낌표 3곳이 전부 빈 상태 재촉에 집중, `$slug.reviews.tsx`에 "생생한" 2회 + "소중한".
- **핵심 지표(난이도)가 이모지** `😊🙂😐😕💀🔥` (`geo-utils.ts:21-29`, 지도 마커 `MapView.tsx:151,179` `💀` 포함). OS별 렌더 상이. `NearbyPlacesSection.tsx:5-11` 카테고리도 이모지.

### 8. 접근성/코드품질 — 심각도 높음
- **로그인 모달 접근 불가** (`Header.tsx:26-59`): role/aria-modal 없음, Escape/focus trap/스크롤 잠금 없음. Radix Dialog 있는데 수제.
- 아이콘 전용 버튼 aria-label 누락: 모바일 검색 트리거(`SearchBar.tsx:243-249`), 검색어 지우기 ×2, 내 위치 버튼.
- 로고 `<img src="/IMG_5843.PNG" alt="">` + 텍스트가 `hidden sm:inline` → 모바일에서 이름 없는 링크. 파일명이 아이폰 스크린샷 원본.
- z-index 임의값 7종 + `Header.tsx:128` `z-30`은 static이라 no-op. Radix 오버레이와 커스텀 드롭다운이 z-50 동률.
- `MapView.tsx` 인라인 HTML 문자열 ~120줄에 hex 색상 하드코딩(`markerColor()`가 `getDifficultyColor()`와 임계값 이중 정의).
- 잘 된 점: 시맨틱 태그 실사용, `sr-only` 병기(`RelatedParkingLotsSection.tsx:34`), `StarRatingInput` slider 키보드 지원(단 내부 button 10개 중첩은 role 충돌), ESC 닫기, `useReducedMotion`.

### 9. 모션 — 심각도 낮음
- motion(framer, ~50KB) 실사용 1파일(`DesktopMapPanel`) — 그 안의 품질은 높음(transform/opacity만, expo-out 상수화, reduced-motion 존중).
- `ParkingCard.tsx:206` `transition-[height]`는 리플로우 유발(저사양 안드로이드 체감). `MobileBottomPanel` 펼침은 애니메이션 없이 즉시 삽입.
- `$slug.reviews.tsx:122`만 `hover:scale-105` + 컬러 섀도우 → 혼자 다른 시스템.

### 10. 메타/SEO — 양호 (설계 수준 높음)
- favicon 세트/og-image 규격/PWA manifest/JSON-LD 3종/동적 noindex 모두 잘 됨.
- 문제: og:image 전 페이지 동일 1장(5,000+ 상세 페이지), 지도 메인 `<h1>` 없음, `favicon.svg`는 Arial "P" 플레이스홀더에 미링크, 헤더 로고와 favicon이 다른 파일.

## 교차 핵심 3가지

1. **난이도 색상 3중 정의** → 디자인 문제가 아니라 정합성 버그. 단일 소스화 필수.
2. **`--primary`(검정) vs 실제 브랜드(blue-500) 분리** → 팔레트 하드코딩 475건과 Button/Card 미사용의 근본 원인.
3. **모바일 우선인데 터치·키보드 상태 미설계** (active 5 / focus-visible 1 vs hover 146).
