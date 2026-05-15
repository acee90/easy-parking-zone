# Scoring Recompute from Fulltext — 2026-05-13

> 크롤링 파이프라인이 snippet(~120자) → fulltext(1.4~2K자)로 전환되면서,
> sentiment 입력값이 옛 snippet 기반 7,872건만 남고 fulltext가 있는 19,541건의
> 대부분이 점수 산정에서 빠지고 있음. 입력을 fulltext로 재생성한 뒤
> parking_lot_stats를 재계산하고 샘플 라벨링으로 검증한다.

## 현황 (2026-05-13 local 스냅샷)

| filter_passed_v2 | full_text='ok' | sentiment 보유 |
|---|---:|---:|
| **= 1** (재계산 대상) | **3,636** | 1,278 |
| = 0 (광고/thin/boilerplate) | 12,686 | 3,313 |
| NULL (v2 미평가) | 3,219 | 2,266 |
| 기타 status (too_short/blocked/등) | 2,456 | — |

핵심 결정:
- **v2=1 & ft_ok 3,636건만 sentiment 재계산** (사용자 지시)
- 기존 `web_sources.sentiment_score`는 전체 NULL로 초기화 후 새로 채움
- scoring 게이트는 `filter_passed_v2 = 1`만 통과 (NULL/0 모두 제외)

## 의사결정 (사전 확정)

- Scope: sentiment 재생성 + parking_lot_stats 재계산
- Eval: 샘플 라벨링 기반 정밀도, 30개 → 성능 OK 시 50개 → 점진 확대 (최대 5회 loop)
- Target: local 검증 후 동일 SQL을 remote에 반영
- v2 처리: scoring 게이트에 `filter_passed_v2 != 0` 추가

---

## Phase 1 — 스냅샷 & 샘플 준비

- before 스냅샷: `data/scoring-before.json` ← parking_lot_stats 전체 dump (final_score, reliability, n_effective)
- 분포 통계: final_score 히스토그램, reliability 분포, 현 sentiment_score 분포
- 평가 샘플 추출: `data/eval-sample-30.json` (점수대 stratified 30 lot)
  - 각 lot당: id, name, address, before final_score, reliability, n_effective
  - 매칭된 web_sources의 fulltext top 3 (길이 우선) + user_reviews

## Phase 2 — Sentiment 초기화 + 재계산

신규: `scripts/recompute-sentiment-from-fulltext.ts`

1. **초기화**: `UPDATE web_sources SET sentiment_score = NULL` (전체)
2. **재계산 대상**: `filter_passed_v2 = 1 AND full_text_status = 'ok'` (~3,636건)
3. 각 row: `analyzeSentiment(full_text)` 실행
   - relevance_score는 v2 판정과 분리, 그대로 둠 (또는 동일 함수 결과로 갱신)
   - sentiment_score = result.sentimentScore
4. SQL emit (`data/sentiment-recompute.sql`)
5. 분포 출력: 새 sentiment 분포 히스토그램, 평균/표준편차
6. local 적용 → 재통계 → OK 시 다음

## Phase 3 — Scoring 게이트에 filter_passed_v2 반영

**무엇을 고치는가**: scoring 계산 시 "어떤 web 글을 입력으로 쓸지" 추리는 SQL에 v2 필터 통과 조건을 더한다.

수정 위치:
- `src/server/crawlers/lib/scoring-engine.ts:213-219` (Workers 런타임용)
- `scripts/compute-parking-stats.ts` (배치 재계산용)

변경:
```sql
-- 기존
WHERE ws.parking_lot_id IN (...)
  AND ws.sentiment_score IS NOT NULL
  AND ws.relevance_score > 30

-- 추가
  AND ws.filter_passed_v2 = 1
```

- `= 1`만 통과 (사용자 지시)
- NULL / 0 모두 제외

## Phase 4 — parking_lot_stats 재계산

- `scripts/compute-parking-stats.ts` 전체 lot 대상 재실행 (또는 recomputeStats 1회용 호출 스크립트)
- after 스냅샷: `data/scoring-after.json`
- 분포 변화 리포트: reliability 등급 이동, final_score Δ 히스토그램

## Phase 5 — Eval Loop (30 → 50 → ... 최대 5회)

각 라운드:

1. 샘플 N개 1-pager 생성 → `data/eval-cards-N.md` (lot당 fulltext 요약/리뷰/before-after)
2. 사람(나)이 1.0~5.0 라벨링 → `data/eval-labels-N.csv`
3. 지표 계산:
   - MAE(before vs human), MAE(after vs human)
   - 난이도 등급(1~5 반올림) 정합률
   - reliability 등급 변화 정합성
4. `data/eval-report-N.md` 저장
5. 판정:
   - **개선됨**: after MAE < before MAE && 등급 정합률 ≥ 65% → 샘플 확대 (다음 라운드 N+20)
   - **회귀**: after MAE ≥ before MAE → 원인 분석 (sentiment 룰 / DAMPING / 가중치) → 보정 후 재측정
6. 최대 5라운드. 누적 표본 30 → 50 → 70 → 90 → 110.

## Phase 6 — Remote 반영

- Phase 2/4 SQL을 `wrangler d1 execute --remote --file=...` 로 적용
- Phase 3 코드 변경은 `bun run deploy` 또는 1회 스크립트 동일 실행
- remote sanity check: final_score 분포가 local과 ±2% 이내 일치하는지

---

## Risks

- **HIGH**: rule-based sentiment가 긴 fulltext에서 키워드 빈도 증가 → 극단치(1.0/5.0) 쏠림 가능. Phase 1 분포에서 미리 확인하고, 필요 시 DAMPING / IDF 재튜닝.
- **MEDIUM**: `compute-parking-stats.ts`와 `scoring-engine.ts` 양쪽에 텍스트 로드 쿼리. 게이트 일관성 유지.
- **MEDIUM**: relevance_score 스케일 — sentiment.ts는 0~1.0 반환, scoring은 0~100 사용. 변환 누락 시 게이트가 모두 닫힘.
- **LOW**: 22K UPDATE는 1000건 chunk → 22 batch (D1 안전 한도).

## 산출물

- `scripts/recompute-sentiment-from-fulltext.ts`
- `data/scoring-before.json`, `data/scoring-after.json`
- `data/sentiment-recompute.sql`
- `data/eval-sample-*.json`, `data/eval-cards-*.md`, `data/eval-labels-*.csv`, `data/eval-report-*.md`
- 코드 패치: `scoring-engine.ts`, `compute-parking-stats.ts`

## 관련 문서

- [crawling-pipeline.md](../references/crawling-pipeline.md) §4 스코어링
- [scoring-calibration.plan.md](./scoring-calibration.plan.md) — 이전 calibration 작업
- [issue-148-filter-relevance-v2.md](./issue-148-filter-relevance-v2.md) — filter_passed_v2 도입
- [issue-140-fulltext-batch.md](./issue-140-fulltext-batch.md) — fulltext 도입
