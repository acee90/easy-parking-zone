# Issue #124 — www vs non-www 도메인 정규화

> 🔧 [SEO P0] Siteliner 진단 `www vs. non-www: Server error` 해결
> 모든 SEO 노력의 전제 조건. AdSense 심사 기본 요건.
>
> **상태: ✅ 종결 (2026-05-03)** — Cloudflare DNS + Redirect Rule 적용, curl 검증 통과.
>
> **후속 이슈** (Siteliner 진단 중 발견):
> - #129 메인 페이지 → wiki 내부 링크 부족 (P0, 색인 누락 근본 원인)
> - #130 Broken Links 15개 (P1)
> - #131 Duplicate Content 26% (P1)

## 1. 진단 결과 (현황 확인)

`curl -I` / `dig` 로 실측한 현재 상태:

| 도메인 | DNS | HTTP 응답 | 비고 |
|---|---|---|---|
| `https://easy-parking.xyz` | A 104.21.53.142 / 172.67.213.135 (Cloudflare) | **200 OK** | ✅ 정상 — canonical |
| `http://easy-parking.xyz` | 동일 | 301 → `https://easy-parking.xyz/` | ✅ HTTP→HTTPS OK |
| `https://www.easy-parking.xyz` | **NXDOMAIN** | — | ❌ DNS 미등록 |
| `https://쉬운주차.com` | — | — | 미사용 (이슈 본문 예시) |

**근본 원인**
- `www.easy-parking.xyz` 에 A/CNAME 레코드가 없어서 Siteliner 가 host 해석 자체에 실패 → "Server error" 로 표시.
- 301 redirect 가 빠진 게 아니라 **DNS 레코드 자체가 없는 상태**.
- 즉, "한쪽 오류" 케이스이며 canonical 분산 위험은 낮으나, SEO 진단 도구·일부 크롤러가 www 만 시도하면 사이트 자체를 찾지 못함.

**선결정 사항 (코드 기준)**
- 코드상 canonical 은 이미 `https://easy-parking.xyz` (non-www) 로 일관됨.
  - `src/routes/__root.tsx:18` — `SITE_URL`
  - `src/server/sitemap-handler.ts:10` — `BASE`
  - `src/routes/index.tsx`, `wiki/*.tsx`, `event/*.tsx` — `<link rel="canonical">`
- 따라서 **canonical = `easy-parking.xyz` (non-www)** 로 확정. www 는 redirect 대상.

## 2. 목표 / 비목표

**목표 (Definition of Done)**

- [ ] `https://www.easy-parking.xyz` 가 200 또는 301 을 응답 (DNS NXDOMAIN 해소)
- [ ] `www.easy-parking.xyz/<path>` → `https://easy-parking.xyz/<path>` 301 redirect (path/query 보존)
- [ ] Siteliner 재검사에서 `www vs. non-www: Server error` 사라짐
- [ ] GSC URL 검사: www 와 non-www 모두 canonical 이 `https://easy-parking.xyz/...` 로 통일됨
- [ ] `<link rel="canonical">` 모든 페이지가 non-www 로 출력됨 (현재 OK, 회귀만 막음)

**비목표 (이번 이슈에서 안 함)**

- 한국어 IDN 도메인 (`쉬운주차.com`) 설정 — 별도 이슈 (구매·연결 작업 필요)
- AdSense 심사 재신청 자체 — canonical 정상화 후 별도 작업
- `BETTER_AUTH_URL`, OAuth callback URL 변경 — non-www 유지로 변경 불필요

## 3. 구현 옵션 비교

| 옵션 | 구현 위치 | 장점 | 단점 |
|---|---|---|---|
| **A. Cloudflare DNS + Bulk Redirect** | Cloudflare 대시보드 | Worker 호출 비용 0, 가장 빠름, edge 에서 처리 | 콘솔 작업 (코드 미반영, IaC 불가) |
| B. DNS + Worker route 추가 + 코드에서 301 | `wrangler.jsonc` + `worker-entry.ts` | 코드로 추적 가능 | Worker 요청 발생 → 비용 ↑, 핵심 경로에 host 체크 코드 추가 |
| C. DNS + Page Rule (Forwarding URL) | Cloudflare 대시보드 | 단순 | Page Rule 슬롯 1 소모, Bulk Redirect 보다 구식 |

**권장: A + B 백업**
- A 로 **즉시** 해결 (DNS + Bulk Redirect, 30분 내).
- B 는 **방어선** — 어떤 host (`www.*`, 다른 alias) 가 붙어도 worker 가 canonical 로 redirect (코드 한 군데).

## 4. 단계별 작업 (Phase)

### Phase 1 — DNS 레코드 추가 (5분)

Cloudflare → easy-parking.xyz → DNS → Records:

```
Type: CNAME
Name: www
Target: easy-parking.xyz
Proxy: 🟧 Proxied (orange cloud)
TTL: Auto
```

**검증**
```bash
dig +short www.easy-parking.xyz
# → 104.21.53.142, 172.67.213.135 (Cloudflare proxy IP) 가 떠야 함
curl -sI https://www.easy-parking.xyz | head -3
# → HTTP/2 200 (아직 redirect 룰 전이라 200 응답이 정상)
```

### Phase 2 — 301 Redirect 룰 추가 (10분)

Cloudflare → easy-parking.xyz → Rules → **Redirect Rules** → Create rule:

| 항목 | 값 |
|---|---|
| Rule name | `Redirect www to apex` |
| When incoming requests match | `Hostname` `equals` `www.easy-parking.xyz` |
| Then... | `Static redirect` |
| Type | `Permanent (301)` |
| URL | `https://easy-parking.xyz` |
| Preserve query string | ✅ |
| Preserve URL path | ✅ (Path forwarding 활성) |

> **중요**: "Preserve URL path" 옵션을 켜야 `/wiki/abc` → `https://easy-parking.xyz/wiki/abc` 로 보존됨. 끄면 모든 경로가 루트로 떨어져 SEO 손실.

**검증**
```bash
curl -sI https://www.easy-parking.xyz/wiki/anywhere | head -5
# → HTTP/2 301
# → location: https://easy-parking.xyz/wiki/anywhere
curl -sI https://www.easy-parking.xyz/?utm=test | head -5
# → location: https://easy-parking.xyz/?utm=test
```

### Phase 3 — Worker 레벨 백업 redirect (선택, 15분) — **SKIPPED**

> Cloudflare 단독 운영자라 대시보드 룰이 임의로 사라질 위험 낮음 → 백업 불필요로 결정 (2026-05-03).


Cloudflare 콘솔 룰이 사라져도 보호되도록 worker 에서 host 체크.

**파일**: `src/server/worker-entry.ts` — `fetch` 핸들러 최상단 (line 231 직후)

```ts
const CANONICAL_HOST = 'easy-parking.xyz'

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url)

    // Canonical host enforcement (www → apex, 301)
    if (url.hostname !== CANONICAL_HOST && url.hostname.endsWith(`.${CANONICAL_HOST}`)) {
      const target = new URL(url.toString())
      target.hostname = CANONICAL_HOST
      target.protocol = 'https:'
      return Response.redirect(target.toString(), 301)
    }

    // ... 기존 로직
  }
}
```

> 단, Phase 2 (Cloudflare Redirect Rule) 가 정상 동작하면 worker 까지 도달하지 않으므로 **방어선**이지 필수는 아님. 룰이 우선 평가됨.

> ⚠️ 로컬 dev (`localhost`, `127.0.0.1`) 와 미리보기 도메인 (`*.workers.dev`) 은 위 조건에 안 걸림 — `endsWith('.easy-parking.xyz')` 로 좁혔기 때문.

### Phase 4 — 회귀 방지 테스트 (10분) — **SKIPPED**

> Phase 3 가 스킵되어 테스트 대상 코드 없음.


**파일**: `src/server/worker-entry.test.ts` 에 케이스 추가

```ts
describe('canonical host redirect', () => {
  it('301 redirects www → apex preserving path and query', async () => {
    const req = new Request('https://www.easy-parking.xyz/wiki/abc?x=1')
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('https://easy-parking.xyz/wiki/abc?x=1')
  })

  it('does not redirect apex requests', async () => {
    const req = new Request('https://easy-parking.xyz/')
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).toBe(200)
  })

  it('does not redirect localhost (dev)', async () => {
    const req = new Request('http://localhost:3000/')
    const res = await worker.fetch(req, mockEnv, mockCtx)
    expect(res.status).not.toBe(301)
  })
})
```

### Phase 5 — GSC / 외부 검증 (5분, 작업 후 24h 모니터링)

1. **Search Console** → 속성 추가 → `https://www.easy-parking.xyz`
   - DNS TXT 또는 HTML 메타 검증
   - 동일 콘텐츠임을 GSC 가 인식 → 자동으로 canonical 통합
2. **Siteliner 재검사**: https://www.siteliner.com — `www vs. non-www` 항목 OK 확인
3. **Bing Webmaster Tools** 도 동일하게 등록 (옵션)
4. 24시간 후 GSC URL 검사에서 "Google-selected canonical" 값 확인

## 5. 리스크 & 완화

| 리스크 | 영향 | 완화 |
|---|---|---|
| Path forwarding 옵션 누락 → 모든 www URL 이 루트로 redirect | **HIGH** SEO 권위 손실, 백링크 깨짐 | Phase 2 검증 단계에서 `curl /wiki/abc` 응답 location 헤더 필수 확인 |
| 302 (temporary) 로 잘못 설정 | **MEDIUM** 검색 엔진이 canonical 통합 안 함 | Cloudflare UI 에서 "Permanent (301)" 명시적 선택 |
| Worker redirect 가 사이트맵·OAuth callback URL 까지 잡음 | **LOW** 외부 통합 깨질 가능성 | 코드상 모든 `BETTER_AUTH_URL` / canonical 이 이미 non-www 라 영향 없음. 검증 필요시 OAuth 로그인 1회 테스트 |
| Cloudflare Redirect Rule 무료 플랜 한도 (10개) 초과 | **LOW** 룰 추가 실패 | 현재 사용 중인 룰 수 확인 필요. 한도 초과 시 옵션 B (worker) 로 전환 |
| GSC 가 www 속성을 새 사이트로 인식해 색인이 분산됨 | **LOW** 일시적 | 301 이 명확하면 GSC 가 자동으로 통합. 1주 모니터링 |

## 6. 롤백 계획

| 단계 | 롤백 |
|---|---|
| Phase 1 (DNS) | Cloudflare DNS 에서 www CNAME 삭제 (NXDOMAIN 으로 복귀, 원상태) |
| Phase 2 (Redirect Rule) | Cloudflare → Rules → Redirect Rules 에서 룰 비활성화 또는 삭제 |
| Phase 3 (Worker) | 코드 revert (`git revert` 후 `bun run deploy`) |

DNS 변경은 TTL 의존 — TTL Auto (Cloudflare 기본 5분) 이므로 5분 내 복귀.

## 7. 작업 순서 / 예상 시간

총 **30~45분** (이슈 본문 명시 30분 부합).

1. Phase 1 (DNS) — 5분
2. Phase 2 (Redirect Rule) — 10분
3. Phase 1·2 검증 (`curl`) — 5분
4. Phase 3 (Worker 백업, 선택) — 15분 + 배포
5. Phase 4 (테스트) — 10분
6. Phase 5 (GSC 등록·Siteliner 재검사) — 5분 + 24h 모니터링

**Phase 1·2 만으로도 이슈 종결 조건 충족.** Phase 3·4 는 회귀 방어용 (별도 PR 가능).

## 8. 검증 체크리스트 (이슈 본문 항목 매핑)

- [ ] `curl -I https://www.easy-parking.xyz` → `301` + `location: https://easy-parking.xyz/`
- [ ] `curl -I https://www.easy-parking.xyz/wiki/test` → `301` + `location: https://easy-parking.xyz/wiki/test`
- [ ] `curl -I http://easy-parking.xyz` → `301` → https (기존 OK)
- [ ] `curl -I https://easy-parking.xyz` → `200` (apex 직접 응답)
- [ ] Siteliner 재검사: `www vs. non-www` 항목에 server error 없음
- [ ] GSC URL 검사: canonical = `https://easy-parking.xyz/...`
- [ ] `<link rel="canonical">` HTML 응답 확인 (회귀 없음)

## 9. 후속 (별도 이슈 권장)

- 한국어 IDN `쉬운주차.com` 도메인 구매·연결 후 동일하게 301 → `easy-parking.xyz` (별도 이슈)
- `sitemap-thin-N.xml` 재평가 — www 이슈 해결 후 색인 회복 추세 보고 결정
- AdSense 재심사 신청 (canonical 정상화 + 1주 안정화 후)
