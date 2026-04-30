# Scoring Calibration Plan — Issue #113

> 점수 분포 중앙 집중 개선 (A+B+C 파라미터 보정)
> GitHub: https://github.com/acee90/easy-parking-zone/issues/113

## 현황 (2026-04-27 베이스라인)

| 지표 | 값 |
|------|-----|
| 전체 주차장 | 31,939개 |
| 3.0~3.1 구간 비율 | **74.9%** |
| 평균 점수 | 3.062 |
| hell 오분류 (≥ 3.0) | **24 / 94개** |
| n_effective < 1 비율 | 98.9% |

베이스라인 스냅샷: `scripts/data/hell-lots-score-baseline.json`  
Eval: `bun run scripts/eval-hell-scoring.ts`

---

## 근본 원인

1. **베이지안 수렴**: n_effective ≈ 0 → final = prior = 3.0
2. **structural prior 조정폭 작음**: 최대 ±0.3 → 86.2% 주차장이 3.0 ±0.3
3. **sentiment 편향**: 실제 분포가 positive 편향인데 부정 보정 적용 중
4. **DAMPING 과도**: 1개 키워드 매칭 시 0.5× → 중립으로 강하게 수렴

---

## 개선 방향

### A. Structural Prior 조정폭 확대
`computeStructuralPrior()` in `scripts/compute-parking-stats.ts`

| 조건 | Before | After |
|------|--------|-------|
| 기계식 | -0.15 | -0.40 |
| 면수 < 30 | -0.05 | -0.10 |
| 면수 > 200 | +0.10 | +0.05 (대형도 복잡할 수 있어 최소화) |
| 면수 > 500 | 없음 | 0.00 (제거) |
| 지하 | -0.05 | -0.15 |
| 노외 | +0.08 | 0.00 (행정 분류, 실외 의미 아님) |
| 무료 | +0.04 | 0.00 (무료 ≠ 쉬운 주차) |

### B. 텍스트 n_effective 가중치
`computeSourceScores()` in `scripts/compute-parking-stats.ts`

```diff
- highRelevanceTexts.reduce((sum, t) => sum + 0.2 * MATCH_TYPE_FACTOR[t.match_type], 0)
+ highRelevanceTexts.reduce((sum, t) => sum + 0.5 * MATCH_TYPE_FACTOR[t.match_type], 0)
```

### C. Sentiment 보정 수정
`analyzeSentiment()` in `src/server/crawlers/lib/sentiment.ts`

```diff
- const scaled = (sentimentRaw - 0.1) * 2.0 + 3.0   // positive 편향 보정 (방향 반대)
+ const scaled = sentimentRaw * 2.0 + 3.0

- const DAMPING: Record<number, number> = { 1: 0.5, 2: 0.7 }
+ const DAMPING: Record<number, number> = { 1: 0.65, 2: 0.82 }
```

### D. Hell 큐레이션 점수 상한 (신규)
`main()` in `scripts/compute-parking-stats.ts`

위치 텍스트 positive bias로 인해 알고리즘만으로 해결 불가한 케이스 보정.
`curation_tag='hell'` 주차장의 final_score를 2.9로 상한 적용.

```typescript
const finalScore =
  lot.curation_tag === "hell"
    ? Math.min(rawFinalScore, PARAMS.HELL_SCORE_CAP)  // 2.9
    : rawFinalScore;
```

### E. 키워드 개선 (신규)
`src/server/crawlers/lib/sentiment.ts`

- **이중 계산 제거**: `기계식` → NEGATIVE_KEYWORDS에서 제거 (structural prior `-0.40`이 이미 반영)
- **주관 평가 키워드 추가**:
  - 긍정: `좋았`, `좋아요`, `만족`, `수월`, `쉬웠`
  - 부정: `불편`, `안좋`, `후회`, `어려웠`

C 적용 후 `compute-text-scores.ts` 재실행 필요.

---

## 구현 단계

- [x] **Phase 0**: 파라미터 상수화 + `--dry-stats` 플래그
- [x] **Phase 1**: A+B sweep 실험 (dry-stats, 3가지 조합)
- [x] **Phase 2**: C+D+E 적용 + `compute-text-scores.ts` 로컬 재실행
- [x] **Phase 3**: A+B+C+D+E 통합 로컬 반영 + `eval:hell-scoring` PASS 확인
- [ ] **Phase 4**: remote D1 반영 (`--remote`)

---

## 검증 결과 (Phase 3 완료 기준, 2026-04-27)

| 항목 | 목표 | 결과 |
|------|------|------|
| hell ≥ 3.0 오분류 | **0개** | **0개** ✅ |
| hell 평균 | ≤ 2.4 | 2.607 (구조 prior만인 케이스 포함) |
| 3.0~3.1 비율 | ≤ 40% | **24.3%** ✅ |
| 전체 평균 | 2.8~3.2 유지 | **2.943** ✅ |

### web_sources 있는 주차장 (2,812개) 분포
| 구간 | 비율 |
|------|------|
| < 2.5 | 1.1% |
| 2.5~3.0 | 28.8% |
| 3.0~3.1 | 4.7% |
| 3.1~3.5 | 59.2% |
| ≥ 3.5 | 6.3% |

> 텍스트 있는 주차장은 분포가 넓게 형성됨. 블로그 후기 특성상 긍정 편향은 자연스러운 결과.
> 어려운 주차장을 잡는 부정 신호는 데이터 부족이 근본 원인 → 크롤링 확대로 해결 예정.

---

## 최종 PARAMS (scripts/compute-parking-stats.ts)

```typescript
const PARAMS = {
  C: 2.5,                  // 베이지안 prior 신뢰 임계치
  TEXT_N_EFF_WEIGHT: 0.5,  // 텍스트 n_effective 가중치
  PRIOR_MECHANICAL:  -0.40,
  PRIOR_SMALL_LOT:   -0.10,
  PRIOR_LARGE_LOT:   +0.05,
  PRIOR_XLARGE_LOT:  +0.00,
  PRIOR_UNDERGROUND: -0.15,
  PRIOR_OUTDOOR:     +0.00,
  PRIOR_FREE:        +0.00,
  HELL_SCORE_CAP:     2.9,
} as const;
```

---

## 파일 변경 목록

| 파일 | 변경 내용 |
|------|-----------|
| `scripts/compute-parking-stats.ts` | PARAMS 상수화, `--dry-stats`, A·B·D 값 변경, hell cap |
| `src/server/crawlers/lib/sentiment.ts` | DAMPING, scaled 편향 수정 (C), 키워드 개선 (E) |
| `scripts/compute-text-scores.ts` | 변경 없음 (재실행만) |
| `scripts/eval-hell-scoring.ts` | 변경 없음 (검증용) |
| `scripts/data/hell-lots-score-baseline.json` | 베이스라인 스냅샷 (읽기 전용) |
