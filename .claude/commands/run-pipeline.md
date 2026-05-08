---
description: 크롤링 파이프라인 스테이지 실행 — dump → process → apply → cleanup
---

# run-pipeline

크롤링 파이프라인의 배치 스테이지를 실행한다.
각 스테이지는 remote D1에서 데이터를 읽고, SQL 청크 파일을 emit한 후, remote에 일괄 apply한다.

## 사용법

```
/run-pipeline [stage] [options]
```

**stage** (기본값: `all`):
- `fulltext` — web_sources_raw의 pending row에 fulltext 보강
- `filter`   — rule filter(high/low) + Haiku AI filter(medium)
- `match`    — 주차장 매칭 → web_sources INSERT
- `scoring`  — parking_lot_stats 재계산
- `all`      — fulltext → filter → match → scoring 순차 실행

**options**:
- `--dry-run`        SQL emit만, remote apply 생략
- `--keep-artifacts` 완료 후 /tmp SQL 파일 유지 (기본: 삭제)
- `--resume`         /tmp에 기존 SQL 파일 감지 시 apply부터 재개

## 실행 절차

각 스테이지는 아래 3단계 템플릿을 따른다:

### 1. Dump (선택적)
```bash
# 현재 pending 카운트 확인 (remote D1)
bunx wrangler d1 execute parking-db --remote --command \
  "SELECT full_text_status, COUNT(*) as cnt FROM web_sources_raw GROUP BY full_text_status"
```

### 2. Process → SQL emit
스크립트를 실행하여 UPDATE SQL을 `/tmp/pipeline-{stage}-{timestamp}/` 에 청크 파일로 emit.

```bash
# fulltext 스테이지 예시
bun run scripts/fetch-matched-fulltext.ts --remote \
  --source=naver_blog --limit=1000 --concurrency=4 \
  --output-dir=/tmp/pipeline-fulltext-$(date +%s)
```

### 3. Apply → Cleanup
```bash
# SQL 청크 일괄 apply
for f in /tmp/pipeline-{stage}-*//*.sql; do
  bunx wrangler d1 execute parking-db --remote --file="$f"
done

# 완료 후 정리 (--keep-artifacts 없을 때)
rm -rf /tmp/pipeline-{stage}-*/
```

## Resume 시나리오

스테이지 실행 중 중단됐을 때:

```
/run-pipeline filter --resume
```

1. `/tmp/pipeline-filter-*/` 디렉토리 스캔
2. 기존 SQL 파일 발견 시 → apply부터 재개 (emit 생략)
3. apply 완료 후 미처리 row 있으면 이어서 process

**상태 컬럼이 체크포인트 역할을 한다:**
- `full_text_status = 'pending'` → fulltext 미처리
- `ai_filtered_at IS NULL` → filter 미처리
- `matched_at IS NULL` → match 미처리

이미 처리된 row는 상태 컬럼으로 자동 스킵되므로 중복 처리 없음.

## 스테이지별 스크립트 매핑

| 스테이지 | 스크립트 / 모듈 | 큐 조건 |
|---------|--------------|--------|
| fulltext | `scripts/fetch-matched-fulltext.ts` (raw 대상) | `full_text_status='pending'` |
| filter | Cron `runAiFilterBatch` (Workers) 또는 추후 스크립트 | `ai_filtered_at IS NULL AND full_text_status='ok'` |
| match | Cron `runMatchBatch` (Workers) 또는 추후 스크립트 | `filter_passed=1 AND matched_at IS NULL` |
| scoring | `scripts/compute-parking-stats.ts` | 최근 matched lot 대상 |

## 주의사항

- remote apply 전 `--dry-run`으로 emit된 SQL 내용을 먼저 확인
- 대량 배치(>10K rows)는 `--concurrency` 낮추고 `--sleep` 추가 (네이버 차단 방지)
- apply 중 오류 발생 시 해당 청크 파일만 재실행 가능 (멱등성 보장)
