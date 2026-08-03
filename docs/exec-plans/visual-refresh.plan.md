# Visual Refresh 실행 계획

> 근거: [design-audit-20260803.md](../design-docs/design-audit-20260803.md)
> 원칙: **UX(화면 구조·동선·기능) 변경 없음.** DAU ~2,500 운영 중이므로 각 단계는 독립 배포 가능하게 쪼개고, push=즉시 배포이므로 단계마다 빌드+라이브 확인.

## 단계

### 1. Pretendard 폰트 도입 + tracking 정리 ✅ (2026-08-03)
- Pretendard Variable(dynamic subset) 로드, `styles.css` body 스택 최우선 배치
- no-op `tracking-normal` 10곳 제거, 큰 헤드라인(text-2xl+)에 `tracking-tight`
- 효과 최대·리스크 최소. 레이아웃 시프트만 확인하면 됨.

### 2. 디자인 토큰 정비
- `--primary`를 브랜드 블루(#3b82f6 계열 oklch)로 교체, `--ring`을 보이는 값으로 수정(WCAG 3:1)
- `--destructive-foreground` 버그 수정
- 중립 스케일 zinc로 통일 방침 결정(신규 코드부터, 기존 gray는 만나는 김에 교체)
- 하드코딩 blue-500 → `bg-primary` 계열로 점진 치환 (한 번에 전부 X — 화면별 검증하며)

### 3. 카드/뱃지 표면 통일
- radius 2단계(컨테이너 rounded-xl / 내부 rounded-lg), shadow 2단계(없음 / shadow-xs)로 축소
- 수제 카드 5종 → `Card` 또는 공용 클래스 경유, 수제 pill → `Badge` variant 경유
- 둘러보기/상세 페이지의 섹션별 표면 위계 부여 (audit의 페이지 진단 참조)

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
