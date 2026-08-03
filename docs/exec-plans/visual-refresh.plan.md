# Visual Refresh 실행 계획

> 근거: [design-audit-20260803.md](../design-docs/design-audit-20260803.md)
> 원칙: **UX(화면 구조·동선·기능) 변경 없음.** DAU ~2,500 운영 중이므로 각 단계는 독립 배포 가능하게 쪼개고, push=즉시 배포이므로 단계마다 빌드+라이브 확인.

## 단계

### 1. Pretendard 폰트 도입 + tracking 정리 ✅ (2026-08-03)
- Pretendard Variable(dynamic subset) 로드, `styles.css` body 스택 최우선 배치
- no-op `tracking-normal` 10곳 제거, 큰 헤드라인(text-2xl+)에 `tracking-tight`
- 효과 최대·리스크 최소. 레이아웃 시프트만 확인하면 됨.

### 2. 디자인 토큰 정비 ✅ (2026-08-03)
- `--primary` = blue-600(oklch 0.546 0.245 262.881, 흰 글자 대비 AA), dark는 blue-500. `--ring` = blue-500, `--destructive-foreground` 버그 수정
- 하드코딩 blue-* → primary 토큰 치환 완료 (26개 파일). 액션 블루는 전부 토큰 경유:
  - 솔리드: `bg-primary` + `hover:bg-primary/90` + `active:bg-primary/80`
  - 틴트: 선택 상태 `bg-primary/10 text-primary`, 리스트 hover/active `bg-primary/5`, AI 요약 카드 `border-primary/15 bg-primary/5`
  - 링크: `text-primary hover:text-primary/80`
- 보류: BlogPostCard 출처별 뱃지(카테고리 색, 3단계에서), MapView 인라인 hex(6단계), event 페이지·admin·test-designs
- 중립 스케일 zinc 통일 방침: 신규 코드부터, 기존 gray는 만나는 김에 교체

### 3. 카드/뱃지 표면 통일 ✅ (2026-08-03) — 시안 D(A+C 하이브리드) 채택
- **표면 규칙**: 페이지 바닥 `bg-zinc-50` / 탭 가능한 카드·콘텐츠 시트 = `rounded-2xl bg-white` (border·shadow 없음) / 회색 필(`bg-zinc-50~100`)은 인풋·정보 웰·pressed 전용 / 내부 칩 `rounded-md bg-zinc-100`
- **인터랙션**: 카드 hover는 그림자·배경 틴트 모두 금지(flat) → 타이틀 `group-hover:text-primary` + 화살표 페이드인. 리스트 row는 bg 틴트 hover 허용. active는 `scale-[0.99]` 또는 짙은 틴트 (사용자 피드백 2회 반영)
- 적용: 둘러보기(/wiki), 상세($slug.index — 문서 콘텐츠는 흰 시트 1장+내부 디바이더, FAQ 카드 나열 제거), reviews/media/blog 탭, all 목록
- 리뷰 폼·제보 폼 노란 테마 제거 → 중립 시트 + zinc-50 인풋 + primary 버튼. 별점 노랑은 유지
- 시안 비교는 dev 전용 /test-designs 페이지에 보존
- 보류: event 페이지, BlogPostCard 출처 뱃지 색상 정리

### 4. 인터랙션 상태 일괄 추가
- 모든 탭 가능 요소에 `active:`(scale/bg), 커스텀 버튼에 `focus-visible:` 링
- 모바일 컴포넌트의 sticky hover 제거 (`hover:` → `@media(hover:hover)` 또는 제거)
- 레이아웃 불변, 상태 클래스만 추가

### 5. 빈 상태/로딩 정리
- 상세페이지 인라인 빈 섹션: 리뷰 탭 수준 빈 상태로 승격 또는 접기
- 고정 크기 카드(리뷰/미디어)에 스켈레톤 도입, `ReviewSection` loading state 추가
- 네트워크 실패 vs 데이터 없음 구분 표시

### 6. 난이도 색상 단일 소스화 + 이모지 교체
- `getDifficultyColor` 3중 정의(geo-utils/ParkingSidebar/MapView) 통합 — 임계값 상이는 버그
- 난이도 이모지 → 일관된 아이콘/색점, 지도 마커 hex도 단일 소스에서 파생
- 로고 자산 정리(IMG_5843.PNG → 정식 파일명, favicon.svg 교체)

## 진행 기록
- 2026-08-03: 감사 완료, 계획 수립, 1단계 진행
