# 구현 계획: 주차장 상세페이지 UI 보강 (#115)

> 선행 이슈: #114 — 정보 구조 및 콘텐츠 섹션 UX 개선
> 방향성: Rotten Tomatoes의 영화 상세/리뷰 UX를 주차장 리뷰/평판 사이트에 맞게 변형

## 요구사항 정리

이슈 #115는 #114 후속작업으로, 상세페이지의 디테일을 다듬는 작업입니다 (Phase 8 출처 표기 + Phase 9 액션 그룹 재배치는 [next-issue-action-group-and-attribution.md](./next-issue-action-group-and-attribution.md)로 분리):

1. 로튼토마토 스타일 리뷰 등록 섹션
2. 신고 버튼 컴포넌트 통일 (pill 형태)
3. 추후 섹션 placeholder 구조
4. carousel 7개 + 더보기 정책
5. 폰트 사이즈 계층화 규칙
6. null 값 fallback 개선
7. 리뷰 카드 간격/peek 조정

## 현재 상태 파악

- 상세 페이지: `src/routes/wiki/$slug.tsx` (434줄, 헤더 직접 인라인)
- 평판 섹션: `ParkingReputationSections` → `expanded=true`로 3개 섹션 동시 노출
- 캐러셀: `Carousel.tsx` (Embla, basis 88vw 모바일 / 400px 데스크톱)
- 리뷰 폼: `ReviewForm.tsx` (104줄, 작은 박스 안에 컴팩트)
- 신고 버튼: `pill` / `icon` 두 variant 혼재 (MediaCard만 pill)
- 캐러셀 페이징: 블로그만 "더보기" 슬라이드, 리뷰/영상은 전체 노출

## 구현 단계 (의존성 순서)

### Phase 1 — 폰트 계층 규칙 정리 (기반)

**먼저 해야 다른 작업이 일관됨**

- 타이포 토큰을 컨벤션으로 합의 (CSS 변수 도입은 과함)
  - 페이지 타이틀: `text-3xl md:text-4xl font-bold`
  - 섹션 타이틀: `text-xl font-bold`
  - 카드 타이틀: `text-base font-semibold`
  - 본문: `text-sm leading-relaxed`
  - 메타: `text-xs text-muted-foreground`
- `$slug.tsx` + 모든 카드 컴포넌트 적용 (현재 base/lg/xl 혼재)

### Phase 2 — null fallback 헬퍼

- `src/lib/parking-display.ts` 신설: `formatOperatingHours`, `formatPricing`, `formatPhone`, `formatTotalSpaces`
- 각 함수가 빈 값/0 처리 → "정보 없음" / "확인 필요" 등 자연스러운 문구
- `$slug.tsx` 기본 정보 섹션 (340-410줄)에 적용
- 운영시간 `0:00-24:00` 같은 미설정 패턴도 감지

### Phase 3 — ReportButton 통일

- `variant` prop 제거 → 항상 pill
- `BlogPostCard`, `UserReviewCard`도 pill 적용 (위치는 카드 우상단 absolute로 통일)
- 카드 내부 텍스트 padding `pr-6` → pill 너비에 맞게 조정

### Phase 4 — 캐러셀 7개 제한 + 더보기 라우트

- 각 섹션에서 데이터를 7개로 slice
- 섹션 타이틀 우측에 "전체 보기 →" 링크 (count > 7일 때만)
- 새 라우트 3개:
  - `/wiki/$slug/reviews` — 전체 사용자 리뷰 (vertical list)
  - `/wiki/$slug/media` — 전체 영상 (grid)
  - `/wiki/$slug/blog` — 전체 웹사이트 글 (compact list, #114에서 권고된 vertical scan 패턴)
- SEO: canonical 부모 페이지로 지정, sitemap 미포함 (thin content 위험)
- Carousel `more` slide 제거 (블로그 무한 페이지네이션 → "전체 보기" 일원화)

### Phase 5 — 리뷰 카드 사이즈/간격 통일

**문제**: 현재 리뷰 카드는 댓글 길이에 따라 높이가 들쭉날쭉, 영상/웹사이트 캐러셀과 카드 간격(gap)·basis가 다름.

- **카드 사이즈 통일 (리뷰 섹션 내)**
  - `UserReviewCard` 고정 높이 또는 min/max-height 지정
  - 댓글 본문 `line-clamp-3` 적용 → 길이 무관 동일 카드 높이
  - 별점/저자/날짜/신고 버튼 위치 정렬 (flex 분배)
- **캐러셀 간격 통일 (3개 섹션 공통)**
  - `Carousel` 컨테이너 `gap-3` → 모든 섹션 동일 값
  - `CarouselSlide` size 토큰 정리:
    - 현재: review `basis-[88vw] sm:basis-[400px] md:basis-[420px]`, media `basis-[88vw] sm:basis-[380px] md:basis-[400px]`
    - 통일안: review/media/blog 모두 동일 basis (예: `basis-[88vw] sm:basis-[380px] md:basis-[400px]`)
  - 모바일 peek 동일하게
- 카드 내부 padding `px-4 py-4` → 일관 적용

### Phase 6 — 로튼토마토 스타일 리뷰 등록 섹션

- 리뷰 섹션 상단에 항상 표시되는 "내 평가 남기기" CTA 카드
  - 큰 별 5개, **0.5점 단위 입력 (총 10단계: 0.5 ~ 5.0)**
    - 별 아이콘을 좌/우 절반으로 나눠 호버/클릭 영역 분리
    - 좌측 절반 호버 → 0.5점 채움(반쪽 별), 우측 절반 호버 → 1.0점 채움
    - 시각화: `fill-yellow-400` 풀 별 + 반쪽 별은 `clip-path` 또는 두 별 겹침 (좌측만 노란색)
    - 키보드 접근성: arrow key로 0.5씩 증감, ARIA `role="slider"` aria-valuemin=0.5 aria-valuemax=5 aria-step=0.5
  - 점수 클릭 → 인라인으로 텍스트 입력 + 등록 버튼 펼쳐짐
  - 마이크로카피: "주차하기 쉬웠나요?", "5점은 누구나 쉽게 주차"
- `ReviewForm` 리팩터링 → step별 시각 위계
- 게스트 닉네임은 텍스트 입력 단계에서만 노출
- **데이터 모델 마이그레이션 (확정)**
  - 현재 스키마 (`migrations/0001_init.sql`): `user_reviews.entry/space/passage/exit/overall_score`
    - 타입: `INTEGER NOT NULL`
    - 제약: `CHECK(score BETWEEN 1 AND 5)` — 정수만 허용
  - 신규 마이그레이션 `0031_review_score_real.sql` 작성
    - SQLite는 ALTER COLUMN 미지원 → 새 테이블 생성 → 데이터 복사 → DROP/RENAME 패턴
    - 5개 컬럼 모두 `REAL NOT NULL CHECK(score BETWEEN 0.5 AND 5)` 로 변경
    - 기존 INTEGER 값은 REAL에 무손실 호환 (1 → 1.0)
    - 인덱스 (`idx_user_reviews_lot`) 재생성 필요
  - `src/db/schema.ts`: `integer('entry_score')` × 5 → `real('entry_score')` × 5
  - `createReview` zod 스키마: `.int().min(1).max(5)` → `.min(0.5).max(5).multipleOf(0.5)`
  - `transforms.ts` rowToReview — number 그대로 통과하므로 변경 없음
  - `UserReviewCard` 별 렌더링: `n <= overall` → 0.5 단위 처리 (반쪽 별 렌더)

### Phase 7 — 미래 섹션 placeholder

- `<UpcomingSection title="주변 콘텐츠" comingSoon />` 컴포넌트 추가
- nearbyPlaces가 비어있을 때 카드 1개로 자리 표시 ("곧 추가될 예정")
- 과도하게 비어 보이지 않게 1줄 placeholder

## 의존성

- Phase 1 → 모든 후속 phase (폰트 토큰)
- Phase 3 → Phase 5 (카드 padding 영향)
- Phase 4 → Phase 6 (리뷰 섹션 구조 변경 동시)

## 리스크

| Severity | Risk | Mitigation |
|---|---|---|
| MEDIUM | 새 라우트 3개 SSR/SEO 영향 | canonical 부모 페이지, robots noindex 검토 |
| MEDIUM | 폰트 크기 변경 시 모바일 줄바꿈 변화 | 각 breakpoint 시각 확인 (320/768/1024) |
| MEDIUM | 로튼토마토 리뷰 폼 변경이 등록률 저하 가능 | 기존 폼과 A/B 비교 어려움 → 단순한 변경 우선 |
| MEDIUM | review score 마이그레이션 (INTEGER → REAL) 데이터 무결성 | 새 테이블 생성 → 복사 → swap 패턴, 백업 후 적용 |
| LOW | Report pill 너비 증가로 카드 영역 좁아짐 | absolute 배치 + truncate 보완 |
| LOW | null fallback 문구 톤 일관성 | 헬퍼에서 단일화 |

## 복잡도: MEDIUM

- Phase 1-3 (기반): 2-3시간
- Phase 4 (라우트): 3-4시간
- Phase 5-6 (UI 디테일 + 마이그레이션): 4-5시간
- Phase 7 (placeholder): 0.5-1시간

총합: **9-13시간**

## PR 분할 제안

1. **PR-1**: Phase 1+2+3 (폰트 토큰 + null fallback + report 통일)
2. **PR-2**: Phase 4 (캐러셀 7개 + 더보기 라우트)
3. **PR-3**: Phase 5+6 (리뷰 폼 + 카드 간격 + 0.5점 마이그레이션)
4. **PR-4**: Phase 7 (placeholder)

## 미해결 논의 사항

- "더보기" 페이지를 새 라우트로 만들지, 같은 페이지에서 expand할지
- 로튼토마토 스타일 리뷰 폼의 microcopy 톤 (장난스러운 vs 친절한)

## 후속 이슈

- [next-issue-action-group-and-attribution.md](./next-issue-action-group-and-attribution.md) — 액션 그룹 재배치 + 공공데이터 API 출처 표기 (사이트 전반 고민)
