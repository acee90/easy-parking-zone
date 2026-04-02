# Security

> 최종 업데이트: 2026-04-02

인증, 데이터 보호, 취약점 관리.

## Authentication

Better Auth 기반. 세션 쿠키 + DB 저장.

| 항목 | 설정 |
|------|------|
| Provider | Better Auth (self-hosted) |
| Session | Cookie-based, D1 저장 |
| Admin 권한 | `user.is_admin` 플래그 |

### Admin Endpoint Protection

모든 어드민 API는 `requireAdmin(request)` 필수:
```typescript
// src/server/admin.ts
async function requireAdmin(request: Request) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user?.id) throw new Error("인증 필요");
  const user = await db.select({ isAdmin: schema.users.isAdmin })...
  if (!user?.isAdmin) throw new Error("관리자 권한 필요");
}
```

## Data Protection

### Secrets Management

Cloudflare Secrets로 관리 (코드/config에 하드코딩 금지):

| Secret | 용도 |
|--------|------|
| `ANTHROPIC_API_KEY` | AI 필터/매칭 (Haiku) |
| `NAVER_CLIENT_ID/SECRET` | 네이버 검색 API |
| `YOUTUBE_API_KEY` | YouTube Data API |
| `BRAVE_SEARCH_API_KEY` | Brave Search API |
| `CRAWL4AI_URL` | DDG 크롤링 프록시 |
| `BETTER_AUTH_SECRET` | 세션 암호화 |

### SQL Injection Prevention

- **필수**: Drizzle ORM 또는 D1 prepared statement (`db.prepare().bind()`)
- **금지**: 문자열 보간으로 SQL 구성 (`WHERE id = ${id}`)
- **예외**: 어드민 source 필터 — ALLOWED_SOURCES 화이트리스트 검증 후 raw SQL

### User Input Validation

| 입력 | 검증 |
|------|------|
| 리뷰 텍스트 | 길이 제한, XSS 이스케이프 (프레임워크 기본) |
| 검색어 | 길이 제한 |
| 파일 업로드 | 없음 (현재 미지원) |
| Admin actions | `requireAdmin` + action type 검증 |

## Content Security

### 콘텐츠 신고 체계

사용자 → 콘텐츠 신고 → 어드민 확인 → 승인 시 `web_sources`에서 DELETE.

### 크롤링 데이터 위생

1. **AI 필터**: 광고/부동산/무관 콘텐츠 자동 제거
2. **HTML 스트리핑**: `stripHtml()` 처리 후 DB 저장
3. **길이 제한**: AI 프롬프트에 본문 200자/2000자 제한

## Vulnerability Checklist

| 카테고리 | 상태 | 비고 |
|----------|------|------|
| SQL Injection | Mitigated | Prepared statements 사용 |
| XSS | Mitigated | React 기본 이스케이프 + SSR |
| CSRF | Mitigated | Cookie SameSite + Better Auth |
| Auth Bypass | Mitigated | 서버사이드 세션 검증 |
| Rate Limiting | Partial | Cloudflare 기본만, 커스텀 미적용 |
| Dependency Audit | Not Active | `bun audit` 정기 실행 검토 |

## TODO

- [ ] Rate limiting 커스텀 구현 (리뷰 작성, 검색 API)
- [ ] Dependency audit CI 자동화
- [ ] CSP 헤더 설정
- [ ] 어드민 2FA 검토
