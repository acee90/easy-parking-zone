# 인증 & 리뷰 시스템 설계서

## 1. 요구사항 정리

### 인증
- 소셜 로그인: 카카오, 네이버, 구글
- Cloudflare Workers + D1 환경
- **better-auth** + **better-auth-cloudflare** 사용 (세션/쿠키 자동 관리)

### 리뷰 (사용자 난이도 평가)
- **회원**: 프로필 연동, 수정/삭제 가능
- **비회원**: 닉네임 입력 후 작성 가능 (수정/삭제 불가)
- 5개 항목 별점 + 텍스트(선택)
- 비회원 스팸 방지: IP 기반 rate limiting

### 블로그 후기 (크롤링 데이터)
- 리뷰와 별도 섹션으로 분리 ("블로그 후기")
- AI 요약(summary) 대신 **원본 스니펫(title + content)** 표시
- AI 요약 데이터는 DB에 유지 (추후 bot 리뷰 seed용)

---

## 2. 인증 아키텍처 (better-auth)

### 2.1 패키지

```bash
bun add better-auth better-auth-cloudflare
```

### 2.2 서버 설정

```typescript
// src/lib/auth.ts
import { betterAuth } from "better-auth";
import { withCloudflare } from "better-auth-cloudflare";
import { anonymous } from "better-auth/plugins";
import { env } from "cloudflare:workers";

export function createAuth() {
  return betterAuth({
    ...withCloudflare({
      d1: {
        db: env.DB,
        options: { usePlural: false },
      },
    }, {
      socialProviders: {
        kakao: {
          clientId: env.KAKAO_CLIENT_ID,
          clientSecret: env.KAKAO_CLIENT_SECRET,
        },
        naver: {
          clientId: env.NAVER_CLIENT_ID,
          clientSecret: env.NAVER_CLIENT_SECRET,
        },
        google: {
          clientId: env.GOOGLE_CLIENT_ID,
          clientSecret: env.GOOGLE_CLIENT_SECRET,
        },
      },
      plugins: [anonymous()],  // 비회원 기능
    }),
  });
}
```

### 2.3 클라이언트 설정

```typescript
// src/lib/auth-client.ts
import { createAuthClient } from "better-auth/react";
import { anonymousClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  plugins: [anonymousClient()],
});

// 사용: authClient.useSession(), authClient.signIn.social()
```

### 2.4 API 라우트 연결

better-auth는 `/api/auth/*` 경로를 자동 처리. TanStack Start에서 catch-all API 라우트로 연결:

```typescript
// src/routes/api/auth/$.ts (catch-all)
import { createAuth } from "@/lib/auth";

export const Route = createAPIFileRoute("/api/auth/$")({
  GET: async ({ request }) => {
    const auth = createAuth();
    return auth.handler(request);
  },
  POST: async ({ request }) => {
    const auth = createAuth();
    return auth.handler(request);
  },
});
```

### 2.5 better-auth가 자동 관리하는 것

- 세션 생성/검증/갱신
- httpOnly 쿠키 설정
- CSRF 보호
- OAuth 콜백 처리
- user/session/account 테이블 스키마 + 마이그레이션

### 2.6 소셜 로그인 플로우

```
[사용자] → [로그인 버튼 클릭]
  → authClient.signIn.social({ provider: "kakao" })
  → [카카오/네이버/구글 동의 화면] (redirect)
  → [/api/auth/callback/:provider] (better-auth 자동 처리)
  → [세션 생성 + 쿠키 설정]
  → [클라이언트 리다이렉트 완료]
```

---

## 3. DB 스키마

### 3.1 better-auth 자동 생성 테이블

better-auth가 `npx @better-auth/cli generate` 또는 `migrate`로 아래 테이블 자동 생성:

```sql
-- better-auth 내부 테이블 (자동 관리)
-- user: id, name, email, emailVerified, image, createdAt, updatedAt
-- session: id, userId, token, expiresAt, ipAddress, userAgent, ...
-- account: id, userId, providerId, accountId, ...
-- verification: id, identifier, value, expiresAt, ...
```

### 3.2 reviews 테이블 확장

기존 `reviews` 테이블에 컬럼 추가:

```sql
-- migrations/0005_review_auth.sql

-- reviews 테이블 확장
ALTER TABLE reviews ADD COLUMN user_id TEXT;        -- better-auth user.id (NULL이면 비회원)
ALTER TABLE reviews ADD COLUMN guest_nickname TEXT;  -- 비회원 닉네임
ALTER TABLE reviews ADD COLUMN ip_hash TEXT;         -- 비회원 스팸 방지용

CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON reviews(user_id);
```

**설계 포인트:**
- `user_id` NULL → 비회원 리뷰
- `user_id` 있음 → better-auth user 테이블 JOIN으로 닉네임/프로필 표시
- `guest_nickname`: 비회원 직접 입력 (기본: "익명")
- `ip_hash`: SHA-256 해시된 IP (원본 저장 안함)

---

## 4. API 설계

### 4.1 인증 API (better-auth 자동)

```
GET/POST /api/auth/*   → better-auth가 전부 처리
```

주요 엔드포인트 (better-auth 내장):
- `/api/auth/sign-in/social` — 소셜 로그인 시작
- `/api/auth/callback/:provider` — OAuth 콜백
- `/api/auth/sign-out` — 로그아웃
- `/api/auth/get-session` — 현재 세션 조회

### 4.2 리뷰 API (직접 구현)

```typescript
// src/server/reviews.ts

/** 주차장별 사용자 리뷰 목록 */
export const fetchUserReviews = createServerFn({ method: "GET" })
  .inputValidator((input: { parkingLotId: string }) => input)
  .handler(async ({ data }) => {
    const db = getDB();
    const result = await db.prepare(`
      SELECT r.*, u.name as user_name, u.image as user_image
      FROM reviews r
      LEFT JOIN user u ON u.id = r.user_id
      WHERE r.parking_lot_id = ?1
      ORDER BY r.created_at DESC
      LIMIT 20
    `).bind(data.parkingLotId).all();
    return result.results;
  });

/** 리뷰 작성 (회원/비회원) */
export const createReview = createServerFn({ method: "POST" })
  .inputValidator(validateReviewInput)
  .handler(async ({ data, request }) => {
    const auth = createAuth();
    const session = await auth.api.getSession({ headers: request.headers });
    const userId = session?.user?.id ?? null;
    const ipHash = await hashIP(getClientIP(request));

    // 비회원 rate limit: 같은 IP + 주차장에 24시간 내 1건
    if (!userId) {
      await checkGuestRateLimit(ipHash, data.parkingLotId);
    }

    await getDB().prepare(`
      INSERT INTO reviews (
        parking_lot_id, user_id, guest_nickname, ip_hash,
        entry_score, space_score, passage_score, exit_score,
        overall_score, comment, visited_at
      ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
    `).bind(
      data.parkingLotId,
      userId,
      userId ? null : (data.guestNickname || "익명"),
      userId ? null : ipHash,
      data.entryScore, data.spaceScore, data.passageScore,
      data.exitScore, data.overallScore,
      data.comment ?? null, data.visitedAt ?? null
    ).run();
  });
```

### 4.3 블로그 후기 API (수정)

기존 `fetchCrawledReviews`를 스니펫 방식으로 변경:

```typescript
/** 주차장별 블로그 후기 (스니펫) */
export const fetchBlogPosts = createServerFn({ method: "GET" })
  .inputValidator((input: { parkingLotId: string }) => input)
  .handler(async ({ data }): Promise<BlogPost[]> => {
    const db = getDB();
    const result = await db.prepare(`
      SELECT title, content, source_url, source, author, published_at
      FROM crawled_reviews
      WHERE parking_lot_id = ?1
        AND relevance_score >= 40
      ORDER BY relevance_score DESC
      LIMIT 5
    `).bind(data.parkingLotId).all<BlogPostRow>();

    return (result.results ?? []).map((row) => ({
      title: row.title,
      snippet: row.content,       // 네이버 API description (스니펫)
      sourceUrl: row.source_url,
      source: row.source,          // 'naver_blog' | 'naver_cafe'
      author: row.author,
      publishedAt: row.published_at,
    }));
  });
```

### 4.4 리뷰/블로그 응답 타입

```typescript
// src/types/review.ts

export interface UserReview {
  id: number;
  author: {
    type: "member" | "guest";
    nickname: string;
    profileImage?: string;
  };
  scores: {
    entry: number;
    space: number;
    passage: number;
    exit: number;
    overall: number;
  };
  comment?: string;
  visitedAt?: string;
  createdAt: string;
  isMine: boolean;
}

export interface BlogPost {
  title: string;
  snippet: string;           // 네이버 검색 스니펫 (원문 일부)
  sourceUrl: string;
  source: "naver_blog" | "naver_cafe";
  author: string;
  publishedAt?: string;
}
```

---

## 5. 비회원 리뷰 정책

| 항목 | 회원 | 비회원 |
|------|------|--------|
| 리뷰 작성 | O | O |
| 닉네임 | 소셜 계정 닉네임 | 직접 입력 (기본: "익명") |
| 프로필 이미지 | O | X (기본 아이콘) |
| 리뷰 수정/삭제 | O (본인 것) | X |
| Rate Limit | 같은 주차장 24h 내 1건 | 같은 IP+주차장 24h 내 1건 |
| 내 리뷰 보기 | O (마이페이지) | X |

**비회원 → 회원 전환 유도:**
- 리뷰 작성 완료 후 "로그인하면 리뷰를 수정/삭제할 수 있어요" 안내
- 리뷰 작성 폼 상단에 간단한 로그인 배너

---

## 6. UI/UX 흐름

### 6.1 상세 패널 구조 (변경 후)

```
[주차장 상세 패널]
  ├── [기본 정보] (기존 - 주소, 운영시간, 요금 등)
  │
  ├── [사용자 리뷰 섹션] ★ 신규
  │    ├── 평균 점수 요약 (항목별 바 차트)
  │    ├── 리뷰 목록 (최신순)
  │    └── [리뷰 쓰기 버튼] → 리뷰 폼
  │
  └── [블로그 후기 섹션] ★ 변경 (AI요약 → 스니펫)
       └── 블로그/카페 글 카드 (제목 + 스니펫 + 출처)
```

### 6.2 헤더 인증 UI

```
[헤더]
  └── 우측
       ├── 비로그인: [로그인] 텍스트 버튼 → 소셜 로그인 모달
       └── 로그인:   [프로필 아바타] → 드롭다운 (내 리뷰, 로그아웃)
```

소셜 로그인 모달:
```
┌────────────────────────┐
│      쉬운주차 로그인      │
│                        │
│  [카카오로 계속하기]      │  ← 노란색
│  [네이버로 계속하기]      │  ← 초록색
│  [구글로 계속하기]        │  ← 흰색/테두리
│                        │
│  비회원도 리뷰 작성 가능   │
└────────────────────────┘
```

### 6.3 리뷰 작성 폼

```
┌─────────────────────────────────────┐
│  주차 난이도 평가                      │
│                                     │
│  (비회원시) 닉네임: [________]        │
│                                     │
│  진입로      ★★★★☆                  │
│  주차면 크기  ★★★☆☆                  │
│  통로 여유   ★★★★★                  │
│  출차 난이도  ★★★☆☆                  │
│  종합 추천도  ★★★★☆                  │
│                                     │
│  한줄평 (선택):                       │
│  ┌───────────────────────────────┐  │
│  │                               │  │
│  └───────────────────────────────┘  │
│                                     │
│  방문일 (선택): [2026-03-01]         │
│                                     │
│  [등록하기]                          │
│                                     │
│  (비회원시)                           │
│  ℹ️ 로그인하면 리뷰를 수정/삭제할 수    │
│     있어요                           │
└─────────────────────────────────────┘
```

### 6.4 리뷰 카드

```
┌─────────────────────────────────────┐
│  [아바타] 닉네임       2026.03.01    │
│  ────────────────────────────────── │
│  진입로 ████░ 4  주차면 ███░░ 3     │
│  통로   █████ 5  출차   ███░░ 3     │
│           종합추천 ████░ 4           │
│  ────────────────────────────────── │
│  "넓고 여유로워서 초보도 편해요"       │
│                        [수정][삭제]  │ ← 본인 리뷰만
└─────────────────────────────────────┘
```

### 6.5 블로그 후기 카드 (변경)

기존 (AI 요약):
```
┌──────────────────────────────┐
│ 👍 주차장이 넓어서 초보도 편합니다 │  ← AI가 요약한 문장
│                [요약 오류 신고]  │
└──────────────────────────────┘
```

변경 후 (원본 스니펫):
```
┌──────────────────────────────────────┐
│  📝 강남역 주차장 이용 후기            │  ← 원본 제목
│  "주차장 진입로가 넓어서 처음 가는     │
│   사람도 쉽게 들어갈 수 있었어요..."   │  ← 네이버 스니펫
│                                      │
│  블로그 · 홍길동 · 2025.12.15        │  ← 출처 정보
└──────────────────────────────────────┘
```

---

## 7. 컴포넌트 구조

```
src/
├── lib/
│   ├── auth.ts               # better-auth 서버 인스턴스
│   └── auth-client.ts        # better-auth 클라이언트 (React)
├── server/
│   ├── parking.ts            # 기존 (fetchBlogPosts로 변경)
│   └── reviews.ts            # 사용자 리뷰 CRUD
├── components/
│   ├── auth/
│   │   ├── LoginModal.tsx      # 소셜 로그인 선택 모달
│   │   └── UserMenu.tsx        # 로그인 후 프로필 드롭다운
│   ├── review/
│   │   ├── ReviewSection.tsx   # 리뷰 섹션 (목록 + 요약 + 작성)
│   │   ├── ReviewCard.tsx      # 개별 리뷰 카드
│   │   ├── ReviewForm.tsx      # 리뷰 작성/수정 폼
│   │   ├── StarRating.tsx      # 별점 입력
│   │   └── ScoreBar.tsx        # 점수 바 표시
│   ├── blog/
│   │   └── BlogPostCard.tsx    # 블로그 스니펫 카드
│   ├── ParkingDetailPanel.tsx  # 기존 (리뷰/블로그 섹션 통합)
│   └── Header.tsx              # 기존 (인증 UI 추가)
├── routes/
│   └── api/auth/$.ts           # better-auth catch-all 핸들러
└── types/
    └── review.ts               # UserReview, BlogPost 타입
```

---

## 8. 환경변수

### wrangler.jsonc (공개 변수)
```jsonc
{
  "vars": {
    "VITE_NAVER_MAP_CLIENT_ID": "uw8likbp4e",
    "BETTER_AUTH_URL": "https://easy-parking.example.com"
  }
}
```

### wrangler secret (비밀 변수)
```bash
wrangler secret put KAKAO_CLIENT_ID
wrangler secret put KAKAO_CLIENT_SECRET
wrangler secret put NAVER_CLIENT_ID
wrangler secret put NAVER_CLIENT_SECRET
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put BETTER_AUTH_SECRET
```

---

## 9. 보안 고려사항

| 위협 | 대응 |
|------|------|
| CSRF | better-auth 내장 CSRF 보호 |
| XSS | httpOnly 쿠키 (better-auth 기본), 리뷰 텍스트 이스케이프 |
| 스팸 리뷰 | 비회원: IP hash 기반 rate limit (24h/1건/주차장) |
| 세션 하이재킹 | better-auth 세션 관리 (토큰 rotation 등) |
| IP 수집 | 원본 IP 저장 안함, SHA-256 해시만 저장 |
| SQL Injection | D1 prepared statements (기존 패턴 유지) |

---

## 10. 구현 순서

### Step 1: 패키지 설치 + better-auth 설정
- `better-auth`, `better-auth-cloudflare` 설치
- auth 서버/클라이언트 설정
- catch-all API 라우트
- `npx @better-auth/cli generate` → 마이그레이션 실행

### Step 2: 소셜 로그인 UI
- LoginModal (카카오/네이버/구글)
- UserMenu (프로필 드롭다운)
- Header에 통합

### Step 3: 블로그 후기 변경
- fetchCrawledReviews → fetchBlogPosts (스니펫 반환)
- BlogPostCard 컴포넌트 (제목 + 스니펫 + 출처)
- ParkingDetailPanel에서 "블로그 후기" 섹션 분리

### Step 4: 사용자 리뷰 시스템
- reviews 테이블 확장 마이그레이션
- createReview / fetchUserReviews 서버 함수
- ReviewForm (별점 + 텍스트)
- ReviewCard / ReviewSection
- 비회원 rate limiting

### Step 5: 리뷰 수정/삭제 (회원)
- updateReview / deleteReview 서버 함수
- ReviewCard에 수정/삭제 버튼 (본인 것만)

### Step 6: 마무리
- 로그인 유도 배너
- 에러/로딩 상태
- 반응형 (모바일 시트)

---

## 부록: AI 요약 데이터 활용 계획

`crawled_reviews.summary` 컬럼은 DB에 유지. 추후 bot 리뷰 seed로 활용:
- AI 요약 내용을 검토 후 적절한 것 선별
- bot 계정으로 reviews 테이블에 INSERT
- 초기 리뷰 데이터 부트스트래핑에 활용
