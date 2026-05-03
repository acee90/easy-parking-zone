# #139 Full-text Fetcher — Pilot Report

- DB: `remote` D1 `parking-db`
- Generated: 2026-05-03T12:04:28.769Z
- Per-source sample: 33
- Concurrency: 3, sleep: 1500ms

## naver_blog (n=33)

### Status distribution

| Status | Count | % |
|---|---:|---:|
| ok | 30 | 90.9% |
| blocked | 0 | 0.0% |
| not_found | 0 | 0.0% |
| too_short | 3 | 9.1% |
| timeout | 0 | 0.0% |
| error | 0 | 0.0% |

### Success rates

- Raw URL success (ok / total): **90.9%** (30/33)
- Public-only success (ok / (total - blocked - not_found)): **90.9%** (30/33)

### Body length (ok rows only, n=30)

| metric | chars |
|---|---:|
| avg | 1921 |
| p25 | 1396 |
| median | 1705 |
| p75 | 2529 |
| max | 3121 |
| min | 751 |

### Sample failures (first 3)

- [too_short] https://blog.naver.com/kjk367/223193383974
- [too_short] https://sonn.tistory.com/2777
- [too_short] https://blog.naver.com/moon1004kr1/223731700291

## naver_cafe (n=33)

### Status distribution

| Status | Count | % |
|---|---:|---:|
| ok | 0 | 0.0% |
| blocked | 33 | 100.0% |
| not_found | 0 | 0.0% |
| too_short | 0 | 0.0% |
| timeout | 0 | 0.0% |
| error | 0 | 0.0% |

### Success rates

- Raw URL success (ok / total): **0.0%** (0/33)
- Public-only success (ok / (total - blocked - not_found)): **0.0%** (0/0)

### Sample failures (first 3)

- [blocked:spa_shell] http://cafe.naver.com/bluegraydnbk8/93347
- [blocked:spa_shell] http://cafe.naver.com/geojerich/279924
- [blocked:spa_shell] http://cafe.naver.com/bablove/73287

## ddg_search (n=33)

### Status distribution

| Status | Count | % |
|---|---:|---:|
| ok | 24 | 72.7% |
| blocked | 3 | 9.1% |
| not_found | 0 | 0.0% |
| too_short | 6 | 18.2% |
| timeout | 0 | 0.0% |
| error | 0 | 0.0% |

### Success rates

- Raw URL success (ok / total): **72.7%** (24/33)
- Public-only success (ok / (total - blocked - not_found)): **80.0%** (24/30)

### Body length (ok rows only, n=24)

| metric | chars |
|---|---:|
| avg | 1480 |
| p25 | 772 |
| median | 1468 |
| p75 | 1657 |
| max | 6502 |
| min | 389 |

### Sample failures (first 3)

- [blocked:login_required] https://place.udanax.org/p/1746338/%EC%A7%84%EA%B3%A1%EC%82%B0%EC%97%85%EB%8B%A8
- [too_short] https://fcpk.purpleo.co.kr/view/12328
- [too_short] https://ontrip.kr/travel-guides/details/126099

## Overall (n=99)

- Raw URL success: **54.5%** (54/99)
- Public-only success: **85.7%** (54/63)

## Pass criteria (#139 doc)

- naver_blog public-only success ≥ 90%
- ddg_search public-only success ≥ 70%
- naver_cafe baseline measurement only (no target)

## Findings

- **naver_blog**: iframe → `.se-main-container` / `.post-view` / `#postViewArea` 추출이 정상 작동. 본문 평균/median 모두 1,500자 이상으로 풍부. 다운스트림 ai_summary 재생성 가치 입증.
- **naver_cafe**: 모바일/데스크탑 모두 단일 페이지 앱(SPA)로 전환되어 단순 HTTP fetch 로는 본문 추출 불가능. `<title>네이버 카페</title>` + `ca-fe.pstatic.net/web-mobile` 자산 패턴으로 SPA shell 감지하여 `blocked:spa_shell` 로 분류. **헤드리스 브라우저 필요 → 본 이슈 범위 외 별도 후속**.
- **ddg_search**: Mozilla Readability + cheerio 폴백 조합이 다양한 도메인에서 잘 동작. 실패는 captcha (뉴스), login wall, boilerplate 위주. 도메인 화이트리스트 운영 여지 있음.
- **광고 라인 제거**: `cleanText` 가 "쿠팡 파트너스" 등 패턴을 제거해 SEO 보일러플레이트 일부 차단.
