# #140 Phase B-4 — Full-text Batch Report

- DB: `remote` D1 `parking-db`
- Generated: 2026-05-03 (after batch + apply + clean-up cycle)
- Source data: `web_sources` 22,398 row (matched). Pre-batch full_text avg 0자.

## Final distribution

| source | ok | blocked | not_found | too_short | timeout | error | total |
|---|---:|---:|---:|---:|---:|---:|---:|
| naver_blog | **9,078** | 5 | 0 | 167 | 90 | 49 | 9,389 |
| naver_cafe | 0 | 3,014 | 0 | 0 | 0 | 0 | 3,014 |
| ddg_search | **7,244** | 451 | 240 | 1,385 | 39 | 23 | 9,382 |
| **합계** | **16,322** | 3,470 | 240 | 1,552 | 129 | 72 | 21,785 |
| (other small sources still pending) | — | — | — | — | — | — | 614 |

`naver_place` (13), `tistory_blog` (600), `youtube_comment` (1) 은 본 이슈 범위 밖 (소량 + 일부 보일러플레이트).

## Success rates

| source | raw | public-only |
|---|---:|---:|
| naver_blog | 96.7% (9,078/9,389) | 96.7% |
| ddg_search | 77.2% (7,244/9,382) | 83.4% (7,244/(9,382−451−240)) |
| naver_cafe | 0% (SPA shell) | n/a |

## Body length (ok rows only)

| source | avg | min | max | n |
|---|---:|---:|---:|---:|
| naver_blog | **1,980자** | 202 | 34,095 | 9,078 |
| ddg_search | **1,336자** | 204 | 56,348 | 7,244 |

→ web_sources.content (snippet) 평균 121자 → web_sources.full_text 평균 1,400~2,000자. **약 12~16배 증가**.

## 운영 노트 (실행 중 발견 + 적용된 가드)

1. **PDF/binary 페이지**: ddg 검색 결과에 PDF URL 일부 섞여 있음. 본문 추출 시 binary가 그대로 들어가 SQL 파싱 깨짐. → fetcher에 `isBinaryDocument()` 가드 추가 + 기존 SQL 파일은 `scripts/clean-pdf-updates.ts` 로 정리.
2. **거대 본문 (> 50KB)**: 단일 UPDATE가 SQLITE_TOOBIG 발생. → `MAX_FULLTEXT_BYTES = 50_000` 가드. 초과 row 는 status='error' 처리.
3. **D1 timeout (D1_RESET_DO)**: ~5MB 단일 SQL 파일 적용 시 가끔 발생. → 250 stmt/file chunk 권장.

## 운영 패턴 (going forward)

신규 크롤링 데이터는 자동으로 `full_text_status='pending'` 으로 큐잉됨. 주기적으로:

```bash
# 풀스윕 (한 source 단위로)
bun run scripts/fetch-matched-fulltext.ts --remote --source=naver_blog --limit=10000 --concurrency=4 --sleep=300 --output-dir=/tmp/fetch-blog

# 또는 ddg 멀티-shard 병렬화
bun run scripts/fetch-matched-fulltext.ts --remote --source=ddg_search --limit=10000 --concurrency=4 --sleep=300 --shards=3 --shard=0 --output-dir=/tmp/fetch-ddg &
bun run scripts/fetch-matched-fulltext.ts --remote --source=ddg_search --limit=10000 --concurrency=4 --sleep=300 --shards=3 --shard=1 --output-dir=/tmp/fetch-ddg &
bun run scripts/fetch-matched-fulltext.ts --remote --source=ddg_search --limit=10000 --concurrency=4 --sleep=300 --shards=3 --shard=2 --output-dir=/tmp/fetch-ddg &
wait

# Apply
for f in /tmp/fetch-{blog,ddg}/*.sql; do bunx wrangler d1 execute parking-db --remote --file="$f"; done
```

## 다음 단계 (#141 Phase C)

`web_sources.ai_summary` 재생성. 입력 = `full_text` (1,400~2,000자 평균) → 풍부한 ai_summary (목표 200자+).
