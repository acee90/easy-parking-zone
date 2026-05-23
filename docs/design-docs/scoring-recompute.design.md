# Scoring / Recompute Design

> **Summary**: 주차장 평점 산출 모델과 리뷰 변경 비동기 재계산 구조 설계
>
> **Project**: easy-parking-zone
> **Date**: 2026-05-23
> **Status**: Implemented
> **Related Issue**: [#158](https://github.com/acee90/easy-parking-zone/issues/158)
> **Operational Reference**: [Scoring / Recompute Architecture](../references/scoring-recompute.md)

---

## 1. Overview

주차장 평점은 사용자 리뷰, 외부 리뷰성 데이터, 웹소스 감성, 주차장 기본 정보를 함께 반영한다.

리뷰 등록/삭제는 사용자 액션이므로 평점이 자동 반영되어야 하지만, 요청 경로에서 직접 재계산하면 응답 지연과 장애 전파가 생긴다. 따라서 리뷰 변경 후 Cloudflare Queue에 lot 단위 재계산 job을 넣고, Queue consumer가 비동기로 `parking_lot_stats`의 scoring 컬럼만 갱신한다.

## 2. Design Goals

- 리뷰 등록/삭제 후 해당 주차장 평점이 자동 갱신된다.
- 리뷰 API 응답은 빠르게 유지하고 평점 반영은 eventual consistency로 둔다.
- 리뷰 변경, 웹소스 변경, 전체 배치가 같은 scoring core를 사용한다.
- scoring writer와 lot-summary writer가 같은 row를 쓰더라도 서로의 컬럼을 덮어쓰지 않는다.
- 외부/seed 리뷰성 데이터는 유저 리뷰와 다른 DB 축으로 분리하지 않는다.
- Queue 장애 또는 enqueue 실패 시 복구 경로를 명확히 둔다.

## 3. Non-goals

- 리뷰 등록 직후 UI polling/refetch UX는 이 설계 범위가 아니다.
- 지도 전체 포인트 캐시 무효화는 별도 작업이다.
- AI 요약/팁 즉시 재생성은 Queue consumer 책임이 아니다.
- Queue enqueue 실패 자동 복구용 outbox/event table은 v1 범위가 아니다.
- `parking_lot_stats` 레거시 컬럼 physical drop은 별도 컬럼 슬림화 작업이다.

## 4. Core Decisions

### 4.1 Queue 기반 리뷰 recompute

리뷰 등록/삭제 성공 후 `SCORE_RECOMPUTE_QUEUE`에 최소 payload를 발행한다.

```ts
type ScoreRecomputeMessage = {
  lotId: string
  reason: 'review_created' | 'review_deleted'
}
```

선택 이유:

- 리뷰 요청 경로에서 D1 read/write 재계산 비용을 분리한다.
- 같은 lot에 리뷰 변경이 몰리면 Queue batch에서 lotId dedupe가 가능하다.
- `recomputeStats`는 UPSERT 기반 idempotent 처리라 at-least-once queue 처리와 맞는다.

대안:

| 대안 | 기각 이유 |
|------|-----------|
| 리뷰 요청에서 직접 recompute | 응답 지연, D1 일시 장애가 리뷰 UX에 전파 |
| 매시간 cron만 사용 | `user_reviews` 변경은 기존 cron의 `matched_at` 대상이 아님 |
| outbox pattern | v1 트래픽/운영 복잡도 대비 과함. enqueue 실패 자동 복구가 필요해지면 후속 도입 |

### 4.2 enqueue 실패는 리뷰 성공을 막지 않음

enqueue 실패 시 리뷰 등록/삭제는 성공으로 유지하고 로그만 남긴다.

```text
review write success
  -> queue send failed
  -> return { ok: true }
  -> operator/manual full recompute if needed
```

선택 이유:

- 평점은 eventual consistency 대상이고, 리뷰 원본 저장이 더 중요한 사용자 액션이다.
- Queue 장애가 리뷰 쓰기 장애로 확산되지 않는다.

trade-off:

- v1에서는 enqueue 실패 자동 fallback이 없다.
- 삭제 이벤트는 deleted row가 남지 않으므로 created_at scan만으로 복구하기 어렵다.
- 복구는 affected lot 수동 recompute 또는 전체 batch recompute로 한다.

### 4.3 consumer 실패는 throw

Queue consumer에서 `recomputeStats`가 실패하면 에러를 swallow하지 않고 throw한다.

선택 이유:

- Cloudflare Queues retry를 정상 사용한다.
- 실패한 batch를 성공 처리하지 않는다.

정상 처리 완료 후에는 message를 ack한다.

### 4.4 scoring writer와 lot-summary writer 분리

`parking_lot_stats`는 점수와 AI 콘텐츠를 함께 저장하지만 writer 책임은 분리한다.

**Scoring owns**

- `structural_prior`
- `review_score`
- `review_count`
- `web_score`
- `web_count`
- `n_effective`
- `final_score`
- `reliability`
- `computed_at`

**Lot summary owns**

- `ai_summary`
- `ai_summary_updated_at`
- `ai_tip_pricing`
- `ai_tip_visit`
- `ai_tip_alternative`
- `ai_tip_updated_at`

선택 이유:

- 기존 `INSERT OR REPLACE`는 row 전체를 교체해 `ai_summary` / `ai_tip_*`를 지울 수 있다.
- scoring과 AI summary는 갱신 시점과 비용 구조가 다르다.
- 리뷰 변경 시 평점은 빠르게 반영하되, 요약/팁은 `/run-pipeline` 또는 lot-summary 파이프라인에서 늦게 반영해도 된다.

구현 규칙:

- scoring writer는 `INSERT OR REPLACE` 금지
- scoring writer는 `INSERT ... ON CONFLICT DO UPDATE`로 scoring 컬럼만 갱신
- lot-summary writer는 summary/tip 컬럼만 갱신

### 4.5 리뷰성 데이터는 review 축으로 통합

기존에는 유저 리뷰와 커뮤니티/seed 데이터를 별도 축으로 볼 수 있었지만, 현행 설계는 `review_score` 하나로 통합한다.

선택 이유:

- 사용자 관점에서는 모두 “리뷰성 평가”다.
- `community_score`라는 별도 공개 축은 의미가 불명확하고 컬럼 수를 늘린다.
- 데이터 신뢰도 차이는 DB 컬럼이 아니라 계산 내부 weight로 표현하는 편이 단순하다.

내부 effective weight:

| 리뷰 종류 | 조건 | weight |
|-----------|------|--------|
| 직접 유저 리뷰 | `is_seed = 0 AND source_type IS NULL` | `1.0` |
| 외부/source 리뷰 | `source_type IS NOT NULL` | `0.6` |
| seed 리뷰 | `is_seed = 1` | `0.3` |

### 4.6 structural prior는 source weight가 아니라 Bayesian anchor

최종 점수는 다음 구조다.

```text
rawSignalScore = weighted_average(active review_score, web_score)

finalScore =
  (PRIOR_C * structuralPrior + nEffective * rawSignalScore)
  / (PRIOR_C + nEffective)
```

현행 파라미터:

```ts
PRIOR_C = 2.5
SOURCE_WEIGHTS = {
  review: 0.6,
  web: 0.4,
}
TEXT_N_EFFECTIVE_WEIGHT = 0.1
HELL_SCORE_CAP = 2.9
```

선택 이유:

- 리뷰가 없을 때는 기본정보 기반 prior를 보여준다.
- 리뷰가 충분히 쌓이면 `final_score`가 `review_score`에 수렴한다.
- 웹소스는 보조 신호로 의미가 있지만, 직접 리뷰보다 낮은 신뢰도로 반영한다.

### 4.7 web score 입력 조건을 명확히 제한

웹소스는 다음 조건을 모두 만족해야 scoring에 들어간다.

- `sentiment_score IS NOT NULL`
- `relevance_score > 30`
- `filter_passed_v2 = 1`

입력 관계:

- 직접 매칭: `web_sources.parking_lot_id`
- AI 매칭: `web_source_ai_matches.parking_lot_id`

AI 매칭은 직접 매칭과 중복되지 않는 경우만 추가한다.

선택 이유:

- 감성 점수가 없는 row가 `web_count`나 `n_effective`만 올리는 문제를 막는다.
- Workers incremental recompute와 전체 batch recompute가 같은 입력 신호를 사용해야 한다.

## 5. Data Model

`migrations/0044_parking_lot_stats_score_axes.sql`에서 신규 축 컬럼을 추가했다.

```sql
ALTER TABLE parking_lot_stats ADD COLUMN review_score REAL;
ALTER TABLE parking_lot_stats ADD COLUMN review_count INTEGER DEFAULT 0;
ALTER TABLE parking_lot_stats ADD COLUMN web_score REAL;
ALTER TABLE parking_lot_stats ADD COLUMN web_count INTEGER DEFAULT 0;
```

backfill:

- `review_count = user_review_count + community_count`
- `review_score`: 기존 `user_review_score`와 `community_score`를 count weighted average
- `web_score = text_sentiment_score`
- `web_count = text_source_count`

레거시 컬럼은 v1에서 삭제하지 않는다.

## 6. Runtime Flow

### 6.1 리뷰 등록

```text
createReview
  -> validate / auth / rate limit
  -> INSERT user_reviews
  -> enqueueScoreRecompute({ lotId, reason: 'review_created' })
  -> return { ok: true }
```

### 6.2 리뷰 삭제

```text
deleteReview
  -> SELECT userId, parkingLotId
  -> auth ownership check
  -> DELETE user_reviews
  -> enqueueScoreRecompute({ lotId, reason: 'review_deleted' })
  -> return { ok: true }
```

### 6.3 Queue consumer

```text
queue(batch)
  -> ignore unknown queue name
  -> collect message.body.lotId
  -> dedupe Set<lotId>
  -> recomputeStats(env.DB, lotIds)
  -> log result
  -> ack messages
```

### 6.4 Web-source cron recompute

```text
scheduled cron
  -> crawl / filter / match
  -> SELECT changed lots by web_sources_raw.matched_at > crawl_progress('scoring')
  -> recomputeStats(env.DB, changedLotIds)
  -> update crawl_progress('scoring')
```

주의: 이 cron은 리뷰 변경 fallback이 아니다.

### 6.5 Full batch recompute

```bash
bun run scripts/compute-parking-stats.ts --remote
```

사용 시점:

- scoring 파라미터 변경
- enqueue 실패/Queue retention 초과 복구
- backfill 이후 전체 정합성 회복

## 7. Consistency Model

| 이벤트 | 반영 모델 |
|--------|-----------|
| 리뷰 등록/삭제 | Queue 기반 eventual consistency |
| 웹소스 매칭 | hourly cron 기반 eventual consistency |
| AI summary/tips | lot-summary pipeline 기반 delayed consistency |
| 전체 파라미터 변경 | batch recompute 필요 |

리뷰 목록과 리뷰 수는 요청 직후 바뀔 수 있지만, `final_score`는 Queue consumer 처리 후 반영된다.

## 8. Failure Handling

| 실패 지점 | 동작 | 복구 |
|-----------|------|------|
| Queue binding 없음 | enqueue helper가 false 반환 + log | binding 설정 후 deploy, 필요 시 batch recompute |
| enqueue send 실패 | 리뷰 성공 유지 + log | affected lot 수동 recompute 또는 전체 batch recompute |
| consumer recompute 실패 | throw | Cloudflare retry |
| Queue retention 초과 | 메시지 유실 가능 | 전체 batch recompute |
| batch recompute 실패 | DB 변경 중단 또는 일부 chunk 실패 가능 | 원인 수정 후 재실행 |

v1에서 outbox를 두지 않는 대신 운영 복구를 명시한다. 리뷰 트래픽 증가나 Queue 장애 빈도가 올라가면 outbox/event table을 후속 설계한다.

## 9. Testing Strategy

단위 테스트:

- `scoring-engine-core.test.ts`
  - prior-only final score
  - 단일 리뷰의 Bayesian anchor
  - review/web source weight 통합
  - seed/source 리뷰의 review 축 통합
- `score-recompute.test.ts`
  - Queue binding send
  - enqueue 실패가 throw되지 않음
  - consumer core lotId dedupe

검증 명령:

```bash
bun x vitest run src/server/crawlers/lib/scoring-engine-core.test.ts src/server/queues/score-recompute.test.ts
bun --bun run build
```

## 10. Open Follow-ups

- 리뷰 등록 직후 UI polling/refetch
- 지도 포인트 캐시 무효화
- Queue DLQ + alerting
- enqueue 실패 자동 복구용 outbox/event table
- `parking_lot_stats.score_version`
- 레거시 score 컬럼 physical drop/rebuild
