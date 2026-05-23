# Scoring / Recompute Architecture

> 최종 업데이트: 2026-05-23
> 설계 배경과 의사결정은 [Scoring / Recompute Design](../design-docs/scoring-recompute.design.md)를 기준으로 한다.

주차장 난이도 평점(`parking_lot_stats.final_score`)을 산출하고 재계산하는 현행 구조.

## 목적

- 리뷰 등록/삭제, 웹소스 매칭 변경, 전체 배치 재계산이 모두 같은 점수 모델을 사용한다.
- 점수 재계산은 `parking_lot_stats`의 scoring 컬럼만 갱신한다.
- AI 요약/팁은 별도 lot-summary 파이프라인 책임으로 두어 scoring 재계산이 콘텐츠 컬럼을 덮어쓰지 않게 한다.

## 관련 파일

| 파일 | 역할 |
|------|------|
| `src/server/crawlers/lib/scoring-engine-core.ts` | 점수 계산 core 함수와 상수 |
| `src/server/crawlers/lib/scoring-engine.ts` | D1 대상 lot 단위 incremental recompute |
| `scripts/compute-parking-stats.ts` | 전체 lot batch recompute |
| `src/server/queues/score-recompute.ts` | Cloudflare Queue producer/consumer helper |
| `src/server/reviews.ts` | 리뷰 등록/삭제 후 recompute job enqueue |
| `src/server/worker-entry.ts` | Queue consumer entrypoint |
| `src/server/scheduled.ts` | web source 변경 lot cron recompute |
| `migrations/0044_parking_lot_stats_score_axes.sql` | scoring 축 컬럼 추가 |

## DB 컬럼 소유권

`parking_lot_stats`에는 점수와 AI 콘텐츠가 함께 있지만 writer 책임을 분리한다.

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

규칙:

- scoring writer는 `INSERT OR REPLACE`를 쓰지 않는다.
- scoring writer는 `INSERT ... ON CONFLICT(parking_lot_id) DO UPDATE`로 scoring 컬럼만 갱신한다.
- lot-summary writer는 summary/tip 컬럼만 갱신한다.
- `ai_summary` / `ai_tip_*`는 scoring 입력으로 사용하지 않는다.

## 점수 모델

최종 평점은 structural prior와 활성 신호를 Bayesian 방식으로 섞는다.

```text
rawSignalScore = weighted_average(active review_score, web_score)

finalScore =
  (PRIOR_C * structuralPrior + nEffective * rawSignalScore)
  / (PRIOR_C + nEffective)
```

현행 상수:

```ts
PRIOR_C = 2.5
SOURCE_WEIGHTS = {
  review: 0.6,
  web: 0.4,
}
TEXT_N_EFFECTIVE_WEIGHT = 0.1
HELL_SCORE_CAP = 2.9
```

해석:

- `structural_prior`는 고정 weight의 소스가 아니라 Bayesian prior(anchor)다.
- 활성 소스만 대상으로 source weight를 재분배한다.
- 리뷰가 충분히 쌓이면 `final_score`는 `review_score`에 수렴한다.
- `curation_tag = 'hell'`인 lot은 최종 점수 상한을 `2.9`로 둔다.

## 입력 신호

### Structural prior

`parking_lots`의 기본 정보로 만든 사전 점수다.

- 기본값: `3.0`
- 기계식: `-0.4`
- 30면 미만: `-0.1`
- 200면 초과: `+0.05`
- 지하 키워드: `-0.15`
- 결과는 `1.0~5.0`으로 clamp

### Review score

`user_reviews` 전체를 하나의 `review_score` 축으로 본다.

직접 유저 리뷰, 외부/source 리뷰, seed 리뷰를 DB 컬럼 축으로 분리하지 않는다. 대신 내부 weight만 다르게 적용한다.

| 리뷰 종류 | 판정 | effective weight |
|-----------|------|------------------|
| 직접 유저 리뷰 | `is_seed = 0` and `source_type IS NULL` | `1.0` |
| 외부/source 리뷰 | `source_type IS NOT NULL` | `0.6` |
| seed 리뷰 | `is_seed = 1` | `0.3` |

- `review_score`: 시간 감쇠가 적용된 weighted average
- `review_count`: `user_reviews` row 수 전체
- `n_effective`: 위 weight 합산

### Web score

`web_sources`의 감성/관련도 기반 보조 신호다.

포함 조건:

- `sentiment_score IS NOT NULL`
- `relevance_score > 30`
- `filter_passed_v2 = 1`

입력 관계:

- 직접 매칭: `web_sources.parking_lot_id`
- AI 매칭: `web_source_ai_matches.parking_lot_id`

AI 매칭은 직접 매칭과 중복되지 않는 경우만 추가한다.

| match_type | factor |
|------------|--------|
| `direct` | `1.0` |
| `ai_high` | `0.8` |
| `ai_medium` | `0.5` |

- `web_score`: `sentiment_score`의 관련도/매칭신뢰도/시간감쇠 weighted average
- `web_count`: 포함 조건을 통과한 web signal 수
- `n_effective`: `relevance_score >= 70`인 신호만 기여하며, 웹소스 전체 기여도는 낮게 제한한다.

## Reliability

`n_effective` 기준으로 신뢰도를 저장한다.

| 조건 | reliability |
|------|-------------|
| `n_effective >= 5` | `confirmed` |
| `n_effective >= 1` | `estimated` |
| `n_effective > 0` | `reference` |
| 활성 신호 없음 | `structural` 또는 `none` |

활성 신호가 없고 structural prior가 정확히 `3.0`이면 `none`, structural prior 보정이 있으면 `structural`이다.

## Recompute 트리거

### 1. 리뷰 등록/삭제

리뷰 변경은 Cloudflare Queue로 비동기 처리한다.

```text
createReview/deleteReview
  -> user_reviews 변경 성공
  -> SCORE_RECOMPUTE_QUEUE.send({ lotId, reason })
  -> queue consumer
  -> batch 내 lotId dedupe
  -> recomputeStats(env.DB, lotIds)
```

메시지:

```ts
type ScoreRecomputeMessage = {
  lotId: string
  reason: 'review_created' | 'review_deleted'
}
```

운영 규칙:

- enqueue 실패는 리뷰 등록/삭제 성공을 막지 않는다.
- enqueue 실패에 대한 자동 fallback은 v1에 없다. 로그 확인 후 수동/전체 recompute로 복구한다.
- consumer 실패는 throw해서 Cloudflare Queues retry에 맡긴다.
- Queue consumer는 AI 요약/팁을 생성하지 않는다.

### 2. 웹소스 매칭 변경

`src/server/scheduled.ts`의 매시간 cron은 `crawl_progress('scoring')` 이후 매칭된 web source를 찾아 해당 lot만 재계산한다.

```sql
SELECT DISTINCT ws.parking_lot_id
FROM web_sources ws
JOIN web_sources_raw r ON r.id = ws.raw_source_id
WHERE r.matched_at > lastScoringRun
```

주의:

- 이 cron은 `web_sources_raw.matched_at` 기반이다.
- `user_reviews` 변경은 이 cron의 자동 fallback 대상이 아니다.

### 3. 전체 batch recompute

전체 점수 재계산은 다음 스크립트를 사용한다.

```bash
bun run scripts/compute-parking-stats.ts --remote
```

용도:

- scoring 파라미터 변경 후 전체 재계산
- enqueue 실패/유실 복구
- 마이그레이션 또는 backfill 이후 정합성 회복

## Queue 설정

`wrangler.jsonc`:

```jsonc
"queues": {
  "producers": [
    {
      "binding": "SCORE_RECOMPUTE_QUEUE",
      "queue": "score-recompute-queue"
    }
  ],
  "consumers": [
    {
      "queue": "score-recompute-queue",
      "max_batch_size": 25,
      "max_batch_timeout": 5,
      "max_retries": 3
    }
  ]
}
```

Queue 생성:

```bash
npx wrangler queues create score-recompute-queue
```

Free plan 기준:

- Queue operations: `10,000/day`
- 메시지 retention: `24h`
- 정상 처리 기준 메시지 1건은 대략 write/read/delete로 3 operations를 사용한다.

## 장애/복구

| 상황 | 영향 | 복구 |
|------|------|------|
| enqueue 실패 | 리뷰는 저장됐지만 점수 job 유실 | 로그 확인 후 affected lot 수동 recompute 또는 전체 batch recompute |
| consumer 실패 | 메시지 retry | Cloudflare Queues retry. 반복 실패 시 로그 확인 |
| 24h 이상 Queue 적체 | 메시지 만료 가능 | 전체 batch recompute |
| `recomputeStats` 오류 | 해당 batch 점수 미반영 | 원인 수정 후 retry 또는 전체 batch recompute |
| scoring 파라미터 변경 | 기존 row가 구버전 점수 유지 | 전체 batch recompute |

## Legacy columns

`0044` 이후 앱/스코어링 코드는 신규 축 컬럼을 사용한다.

- `review_score`
- `review_count`
- `web_score`
- `web_count`

아래 컬럼은 레거시 backfill/호환 용도로 DB에 남아 있다.

- `user_review_score`
- `user_review_count`
- `community_score`
- `community_count`
- `text_sentiment_score`
- `text_source_count`

물리적 drop/rebuild는 별도 컬럼 슬림화 작업에서 처리한다.
