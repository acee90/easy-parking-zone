# Issue #158 — 유저 리뷰 등록/삭제 시 주차장 평점 비동기 재계산

> 원본 이슈: [acee90/easy-parking-zone#158](https://github.com/acee90/easy-parking-zone/issues/158)
> Design: [Scoring / Recompute Design](../design-docs/scoring-recompute.design.md)
> Reference: [Scoring / Recompute Architecture](../references/scoring-recompute.md)

## 1. 요구사항 재정의

- 리뷰 등록(`createReview`) · 삭제(`deleteReview`)가 성공한 직후, 해당 주차장의 `parking_lot_stats.final_score`가 자동 재계산되어야 한다.
- UX 측면에선 리뷰 등록/삭제 응답은 기존처럼 빠르게(`{ ok: true }`) 반환해야 하고, 점수 반영은 수 초 내 eventual consistency 로 둔다.
- Cloudflare Queues 를 producer/consumer 로 사용해 비동기 처리.
- Queue enqueue 실패는 리뷰 등록/삭제 자체를 막지 않고, consumer 실패는 throw 해서 Cloudflare 재시도에 맡긴다.
- 적용 범위는 상세/위키에서 보이는 평점. 지도 전체 캐시(`fetchAllParkingPoints` 1h) 무효화는 후속 이슈로 분리.
- 본 이슈의 Queue consumer 는 **평점 재계산만** 수행한다. AI 요약·팁(`ai_summary`, `ai_tip_*`) 재생성은 `/run-pipeline` 또는 lot-summary 파이프라인에서 별도로 처리한다.
- Queue enqueue 실패에 대한 자동 fallback 은 v1 범위에 포함하지 않는다. 실패는 로그로 남기고, 운영 복구는 전체/수동 스코어 재계산으로 처리한다.

## 2. 현재 상태 검수 (코드베이스 기준)

| 항목 | 현재 상태 | 비고 |
|------|------|------|
| `createReview` (`src/server/reviews.ts:86`) | insert 성공 후 `{ ok: true }` 만 반환 | enqueue 훅 없음 |
| `deleteReview` (`src/server/reviews.ts:157`) | `select({ userId })` 만 조회 후 삭제 | **`parkingLotId` 미조회** → 보강 필요 |
| `recomputeStats` (`src/server/crawlers/lib/scoring-engine.ts:178`) | `(db: D1Database, lotIds: string[]) → { updated }` 이지만 `INSERT OR REPLACE` 사용 | **ai_summary/ai_tip_* 소실 위험** → `ON CONFLICT DO UPDATE` 로 변경 필요 |
| scoring 파라미터 | Workers용 `recomputeStats` 와 배치용 `compute-parking-stats.ts` 의 `C`/prior 값이 다름 | Queue 재계산값과 배치 재계산값이 달라질 수 있음 → 공통화 필요 |
| `parking_lot_stats` 컬럼 소유권 | 점수 컬럼과 AI 콘텐츠 컬럼이 같은 테이블에 공존 | writer별 업데이트 컬럼을 명확히 분리해야 함 |
| `worker-entry.ts` (`src/server/worker-entry.ts:222`) | `fetch` + `scheduled` 만 export. `Env` 인터페이스 로컬 정의 | `queue` handler 추가 + `Env` 확장 필요 |
| Queue binding | `wrangler.jsonc` 에 없음 | producer + consumer 양쪽 추가 필요 |
| `env` 접근 방식 | server fn 안에서는 `import { env } from 'cloudflare:workers'` (예: `src/db/index.ts:1`) | enqueue helper도 동일 패턴 사용 |
| Queue 타입 | `worker-configuration.d.ts` (cf-typegen 산출물) | 토글 후 `bun run cf-typegen` 필요 |
| 테스트 | `reviews.test.ts` 는 `rowToReview/validateScore` 순수 함수만 테스트. server-fn handler 자체 테스트 없음 | enqueue 로직을 pure function 으로 분리해서 단위 테스트 가능하게 설계 |

위 차이를 반영하되, Queue 도입 전에 `parking_lot_stats` 업데이트 방식과 scoring 알고리즘 단일화를 먼저 정리해야 한다.

## 3. 구현 계획

### Phase 1 — Queue binding 추가
**파일**: `wrangler.jsonc`

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

- Queue 생성은 배포 전 1회 수동: `npx wrangler queues create score-recompute-queue`
- 적용 후 `bun run cf-typegen` 으로 `worker-configuration.d.ts` 의 `Cloudflare.Env` 갱신 확인.
- Cloudflare Queues 는 Free plan 에서도 사용 가능하다. 단 Free plan 은 Queue operations 10,000/day, message retention 24h 고정 제약이 있으므로 운영 기준에 반영한다.

### Phase 2 — scoring 컬럼 소유권 분리 + UPSERT 수정

`parking_lot_stats` 는 점수와 AI 콘텐츠를 함께 들고 있지만, writer 책임은 분리한다.

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

구현 규칙:
- `recomputeStats` 와 `compute-parking-stats.ts` 에서 `INSERT OR REPLACE INTO parking_lot_stats` 사용 금지.
- scoring writer 는 `INSERT INTO ... ON CONFLICT(parking_lot_id) DO UPDATE SET ...` 으로 scoring 컬럼만 업데이트한다.
- lot-summary writer 는 현재처럼 summary/tip 컬럼만 업데이트한다.
- `parking_lot_stats.ai_summary` / `ai_tip_*` 는 scoring 입력으로 사용하지 않는다.
- Queue consumer 는 AI 호출을 하지 않고 summary/tip 컬럼을 업데이트하지 않는다.

예시:

```sql
INSERT INTO parking_lot_stats (
  parking_lot_id,
  structural_prior,
  review_score,
  review_count,
  web_score,
  web_count,
  n_effective,
  final_score,
  reliability,
  computed_at
) VALUES (...)
ON CONFLICT(parking_lot_id) DO UPDATE SET
  structural_prior = excluded.structural_prior,
  review_score = excluded.review_score,
  review_count = excluded.review_count,
  web_score = excluded.web_score,
  web_count = excluded.web_count,
  n_effective = excluded.n_effective,
  final_score = excluded.final_score,
  reliability = excluded.reliability,
  computed_at = excluded.computed_at;
```

### Phase 3 — scoring 알고리즘 단일화

Workers Queue 재계산과 전체 배치 재계산이 같은 결과를 내야 한다.

권장 구현:
- scoring core 를 공통 모듈로 분리한다. 예: `src/server/crawlers/lib/scoring-engine-core.ts`
- `src/server/crawlers/lib/scoring-engine.ts` 와 `scripts/compute-parking-stats.ts` 가 같은 constants / functions 를 사용한다.
- 기존 Workers용 `C = 1.5` 와 배치용 `PARAMS.C = 2.5` 불일치를 제거한다.

점수 모델:

```text
finalScore =
  (PRIOR_C * structuralPrior + nEffective * rawSignalScore)
  / (PRIOR_C + nEffective)
```

기본 파라미터:

```ts
const SCORE_PARAMS = {
  PRIOR_C: 2.5,
  SOURCE_WEIGHTS: {
    review: 0.6,
    web: 0.4,
  },
  TEXT_N_EFFECTIVE_WEIGHT: 0.1,
  HELL_SCORE_CAP: 2.9,
}
```

해석:
- `structural_prior` 는 고정 비율 소스가 아니라 Bayesian prior(anchor) 로만 사용한다.
- `review_score` 는 `user_reviews` 전체를 기반으로 한다. 직접 유저 리뷰, 외부/source 리뷰, seed 리뷰를 별도 DB 축으로 나누지 않는다.
- 리뷰 점수 계산 내부에서는 신뢰도 차이를 weight 로 반영한다: 직접 리뷰 1.0, source_type 리뷰 0.6, seed 리뷰 0.3.
- `web_score` 는 `web_sources.sentiment_score` / `relevance_score` 기반 보조 신호다.
- direct review 1건의 `n_effective` 는 1.0, source_type review 1건은 0.6, seed review 1건은 0.3, high relevance web source 1건은 최대 0.1 로 둔다.
- 웹소스는 직접 매칭(`web_sources.parking_lot_id`)과 AI 매칭(`web_source_ai_matches`)을 모두 반영한다. 단 `sentiment_score IS NOT NULL`, `relevance_score > 30`, `filter_passed_v2 = 1` 조건을 만족한 신호만 `web_score`/`web_count`/`n_effective`에 들어간다.
- high relevance web source 총 기여도는 기존처럼 최대 1.0 수준으로 제한한다.
- 활성 소스만 대상으로 weight 를 재분배하되, 리뷰가 충분히 쌓이면 `final_score` 는 `review_score` 에 수렴해야 한다.

DB 저장값:
- 최종 평점만 저장하지 않는다.
- `structural_prior`, `review_score`, `review_count`, `web_score`, `web_count`, `n_effective`, `final_score`, `reliability` 를 모두 저장한다.
- `score_version` 컬럼 추가는 이번 이슈 필수 범위는 아니지만, scoring 파라미터 변경 추적용 후속 후보로 둔다.

마이그레이션 방침:
- v1 에서는 신규 컬럼(`review_score`, `review_count`, `web_score`, `web_count`)을 추가하고 앱/스코어링 코드를 신규 컬럼으로 전환한다.
- 기존 `user_review_*`, `community_*`, `text_*` 컬럼은 레거시로 남긴다. 실제 drop/rebuild 는 별도 컬럼 슬림화 이슈에서 처리한다.

### Phase 4 — 메시지 타입 + Env 확장
**파일**: 새 파일 `src/server/queues/score-recompute.ts`

```ts
import { env } from 'cloudflare:workers'

export type ScoreRecomputeReason = 'review_created' | 'review_deleted'

export interface ScoreRecomputeMessage {
  lotId: string
  reason: ScoreRecomputeReason
}

export async function enqueueScoreRecompute(
  msg: ScoreRecomputeMessage,
): Promise<{ enqueued: boolean }> {
  try {
    const queue = (env as unknown as { SCORE_RECOMPUTE_QUEUE?: Queue<ScoreRecomputeMessage> })
      .SCORE_RECOMPUTE_QUEUE
    if (!queue) {
      console.error('[score-recompute-queue] binding missing, skip enqueue', msg)
      return { enqueued: false }
    }
    await queue.send(msg)
    return { enqueued: true }
  } catch (err) {
    console.error('[score-recompute-queue] enqueue failed', msg, err)
    return { enqueued: false }
  }
}
```

**파일**: `src/server/worker-entry.ts`
- 로컬 `Env` 인터페이스에 `SCORE_RECOMPUTE_QUEUE: Queue<ScoreRecomputeMessage>` 추가.
- `cf-typegen` 산출물 활용으로 점진적으로 통합 가능하면 그쪽도 함께 정렬.

### Phase 5 — 리뷰 경로에 enqueue 연결
**파일**: `src/server/reviews.ts`

- `createReview` handler — `db.insert(...).values(...)` 성공 직후:
  ```ts
  await enqueueScoreRecompute({
    lotId: data.parkingLotId,
    reason: 'review_created',
  })
  return { ok: true }
  ```
- `deleteReview` handler:
  1. 기존 select 에 `parkingLotId` 추가
     ```ts
     const review = await db
       .select({
         userId: schema.userReviews.userId,
         parkingLotId: schema.userReviews.parkingLotId,
       })
       .from(schema.userReviews)
       .where(eq(schema.userReviews.id, data.reviewId))
       .get()
     ```
  2. 권한 검증 통과 + delete 성공 후
     ```ts
     await enqueueScoreRecompute({
       lotId: review.parkingLotId,
       reason: 'review_deleted',
     })
     return { ok: true }
     ```

- rate-limit / 권한 실패 경로에선 enqueue 호출하지 않음.
- enqueue 실패(`{ enqueued: false }`)는 리뷰 등록/삭제 성공을 막지 않음. 자동 fallback 은 v1 에서 제공하지 않는다.

### Phase 6 — Queue consumer
**파일**: `src/server/worker-entry.ts` (default export)

```ts
async queue(batch: MessageBatch<ScoreRecomputeMessage>, env: Env, _ctx: ExecutionContext) {
  if (batch.queue !== 'score-recompute-queue') return

  const lotIds = new Set<string>()
  for (const msg of batch.messages) {
    const lotId = msg.body?.lotId
    if (typeof lotId === 'string' && lotId.length > 0) {
      lotIds.add(lotId)
    }
  }

  if (lotIds.size === 0) {
    for (const m of batch.messages) m.ack()
    return
  }

  const ids = [...lotIds]
  const result = await recomputeStats(env.DB, ids)
  console.log(
    `[score-recompute-queue] ${result.updated}/${ids.length} lots recomputed from ${batch.messages.length} messages`,
  )
  for (const m of batch.messages) m.ack()
}
```

- `recomputeStats` import: `import { recomputeStats } from './crawlers/lib/scoring-engine'`
- 실패 시 throw 하여 Cloudflare 재시도 / DLQ 동작에 위임.
- 테스트 가능성을 위해 batch 처리 core 는 `src/server/queues/score-recompute.ts` 로 분리한다. `worker-entry.ts` 는 `MessageBatch` 를 helper 에 넘기는 얇은 adapter 로 둔다.

### Phase 7 — 테스트
**파일**: 신규 `src/server/queues/score-recompute.test.ts`

- `enqueueScoreRecompute` 단위 테스트
  - binding 이 있을 때 `send` 가 정확한 payload 로 1회 호출되는지
  - `send` 가 throw 해도 함수 자체는 reject 하지 않고 `{ enqueued: false }` 를 반환하는지
  - binding 이 없을 때 `{ enqueued: false }` 를 반환하는지

**파일**: 신규 `src/server/crawlers/lib/scoring-engine-core.test.ts`

- scoring core 단위 테스트
  - `structural_prior` 만 있을 때 `final_score` 가 prior 로 저장되는지
  - user review 1건 5점 + prior 3.0 일 때 Bayesian anchor 로 5점 과대평가가 억제되는지
  - review/web 활성 소스 weight 가 `0.6/0.4` 기준으로 재분배되는지
  - seed/source 리뷰가 별도 DB 축이 아니라 `review_score` 에 통합되고 내부 weight 만 낮아지는지
  - Workers recompute 와 batch 경로가 같은 core 함수/상수를 쓰는지
  - scoring UPSERT 가 summary/tip 컬럼을 업데이트하지 않는지

**파일**: 신규 또는 확장 `src/server/worker-entry.queue.test.ts`

- queue handler 단위 테스트 (consumer 로직만)
  - 같은 lotId 중복 메시지를 dedupe 해서 `recomputeStats` 가 1회만 호출되는지
  - 빈 lotId / undefined body 메시지가 섞여도 안전한지
  - `recomputeStats` 가 throw 하면 handler 도 throw 하는지
  - 정상 흐름에서 모든 message 가 ack 되는지

**파일**: `src/server/reviews.test.ts` 확장
- `createReview` / `deleteReview` 자체는 server-fn 래퍼 때문에 직접 테스트 비용이 큼 → enqueue 로직을 helper 로 모듈화한 것을 활용해서 호출 시점 / 인자 검증을 단위 테스트에 노출.
- 통합 테스트는 별도 시도 대신 수동 검증 체크리스트로 대체.

최종 확인: `bun --bun run test`.

### Phase 8 — 배포 절차
1. `npx wrangler queues create score-recompute-queue`
2. PR merge → `bun run cf-typegen`
3. `git push` 로 Cloudflare Workers 자동 배포
4. dashboard 에서 producer/consumer binding 정상 연결 확인
5. 한 lot 에 리뷰 작성 → wrangler tail 로그에서 `[score-recompute-queue]` 메시지 + `parking_lot_stats.final_score` 변동 확인

## 4. 리스크 / 결정

| 항목 | 평가 | 대응 |
|------|------|------|
| Queue binding 누락 상태 배포 | 중간 — type 누락 + 런타임 enqueue skip | helper 에서 missing binding 시 console.error + skip. **자동 fallback 없음** |
| enqueue 실패 | 중간 — 리뷰는 저장됐지만 재계산 job 유실 | `{ enqueued: false }` + console.error. 운영 복구는 수동/전체 스코어 재계산 |
| delete enqueue 실패 | 중간 — 삭제 row 가 남지 않아 최근 created_at scan 으로 복구 불가 | outbox/review_events 없이는 자동 복구하지 않음. 후속 이슈 후보 |
| recomputeStats 실패 | 낮음 — UPSERT 멱등 | consumer throw → Cloudflare 재시도, 3회 후 DLQ 없음(이번 범위) |
| scoring 이 lot-summary 컬럼 소실 | 높음 — 현재 `INSERT OR REPLACE` 는 기존 row 를 대체할 수 있음 | 본 이슈에서 `ON CONFLICT DO UPDATE` 로 scoring 컬럼만 업데이트 |
| Workers recompute 와 배치 scoring 불일치 | 높음 — 현재 `C`/prior 값이 다름 | scoring core 공통화 + weight 통일 |
| 동시 다발 리뷰 → 큐 폭주 | 낮음 — `max_batch_size=25` + Set dedupe | 실제 운영에서 lot 단위 중복이 강함 |
| 지도 전체 캐시(`fetchAllParkingPoints` 1h) 불일치 | 인정 — 본 이슈 범위 외 | 후속 이슈로 분리 명시 |
| 리뷰 등록 직후 UI 평점 갱신 | 인정 — eventual consistency | polling/refetch UX 는 후속 이슈 |
| Queue 비용/한도 | Free plan 사용 가능하나 operations 10,000/day, retention 24h 제한 | 리뷰 변경량 3,000건/day 이상 또는 장애 24h 가능성이 보이면 Paid/보강 설계 검토 |

## 5. 변경 파일 요약

- `wrangler.jsonc` — queues producer/consumer
- `src/server/queues/score-recompute.ts` (신규)
- `src/server/queues/score-recompute.test.ts` (신규)
- `src/server/crawlers/lib/scoring-engine-core.ts` (신규 또는 기존 core 이동)
- `src/server/crawlers/lib/scoring-engine-core.test.ts` (신규)
- `src/server/crawlers/lib/scoring-engine.ts` — 공통 scoring core 사용 + scoring 컬럼만 UPSERT
- `scripts/compute-parking-stats.ts` — 공통 scoring core 사용 + scoring 컬럼만 UPSERT
- `src/server/worker-entry.ts` — `Env` 확장 + `queue` export
- `src/server/worker-entry.queue.test.ts` (신규)
- `src/server/reviews.ts` — `createReview`/`deleteReview` enqueue 연결, `deleteReview` select 보강
- `worker-configuration.d.ts` — `bun run cf-typegen` 산출물 갱신 (자동)

## 6. 후속 이슈 (out of scope)

- 리뷰 등록 직후 평점 UI polling/refetch
- `fetchAllParkingPoints` 캐시 무효화
- Queue DLQ + alerting 운영 표준
- enqueue 실패 자동 복구용 outbox/review_events 테이블
- 리뷰 변경 lot 을 lot-summary 파이프라인 우선순위에 반영
- `parking_lot_stats.score_version` 컬럼 추가
