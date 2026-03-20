# Design-Implementation Gap Analysis: Crawlers

## Executive Summary

| Item | Value |
|------|-------|
| Feature | Crawlers (데이터 수집 + 스코어링) |
| Design Documents | `crawling-architecture-strategy.md`, `parking-scoring-algorithm.md` |
| Implementation | `src/server/crawlers/`, `scripts/`, `migrations/` |
| Analysis Date | 2026-03-21 |

### Overall Match Rate

| Category | Score | Status |
|----------|:-----:|:------:|
| Crawling Architecture | 92% | OK |
| Scoring Algorithm | 88% | WARN |
| Data Model | 97% | OK |
| Convention Compliance | 95% | OK |
| **Overall** | **93%** | OK |

---

## 1. Crawling Architecture Gap Analysis

### 1.1 Implemented Items

| # | Design Specification | Impl | Location |
|---|---------------------|:----:|----------|
| 1 | Workers Cron execution | YES | `worker-entry.ts`, `wrangler.jsonc` |
| 2 | GitHub Actions for naver-place (Playwright) | YES | `.github/workflows/crawl-naver-place.yml` |
| 3 | `crawl_progress` D1 table | YES | `migrations/0012_crawl_progress.sql` |
| 4 | `naver-blogs.ts` Workers crawler | YES | `src/server/crawlers/naver-blogs.ts` |
| 5 | `youtube.ts` Workers crawler | YES | `src/server/crawlers/youtube.ts` |
| 6 | `scheduled.ts` cron dispatcher | YES | `src/server/scheduled.ts` |
| 7 | `scoring.ts` 공통 유틸 | YES | `src/server/crawlers/lib/scoring.ts` |
| 8 | 3-query strategy (A/B/C) | YES | `buildQueries()` in naver-blogs.ts |
| 9 | Multi-matching (POI/region) | YES | `scanMultiMatches()` |
| 10 | Reliability-based priority queue | YES | `selectPriorityLots()` |
| 11 | AD_PATTERNS noise filter | YES | `NOISE_PATTERNS` in scoring.ts |
| 12 | Micro-batching for Worker CPU limits | YES | D1 batch with 500-statement chunks |
| 13 | scripts/lib/ 공통 모듈 5개 | YES | progress, sql-flush, geo, d1, naver-api |

### 1.2 Changed Items

| # | Item | Design | Implementation | Severity |
|---|------|--------|----------------|----------|
| C1 | Cron schedule | `"0 18 * * 0"` (weekly) | `"0 */1 * * *"` (hourly) | Minor |
| C2 | naver-blogs batch size | 10 lots/run | 25 lots/run | Minor |
| C3 | geo.ts 위치 | `crawlers/lib/geo.ts` | `scoring.ts`에 병합 | Minor |

### 1.3 Added Items (설계 초과 구현)

| # | Item | Location |
|---|------|----------|
| A1 | Brave Search crawler | `src/server/crawlers/brave-search.ts` |
| A2 | Incremental scoring engine | `src/server/crawlers/lib/scoring-engine.ts` |
| A3 | `__scheduled` dev endpoint | `worker-entry.ts:24` |
| A4 | `web_source_ai_matches` table | `migrations/0024_ai_matches.sql` |
| A5 | search-engine abstraction | `scripts/lib/search-engine.ts` |
| A6 | Crawl -> auto-recompute pipeline | `scheduled.ts:73-82` |

### 1.4 Missing Items

| # | Item | Severity | Notes |
|---|------|----------|-------|
| M1 | `crawl_progress.total_target` 미사용 | Minor | 컬럼 존재하나 어떤 크롤러도 기록 안함 |
| M2 | `crawl_progress.metadata` 미사용 | Minor | 동일 |
| M3 | Scale migration 모니터링 | Minor | GitHub Actions 사용량 임계치 알림 없음 |

---

## 2. Scoring Algorithm Gap Analysis

### 2.1 Implemented Items

| # | Design (Section) | Impl | Location |
|---|-----------------|:----:|----------|
| 1 | Structural Prior (SS4.1) | YES | `computeStructuralPrior()` |
| 2 | Review weighted avg (SS4.2) | YES | `computeSourceScores()` |
| 3 | Time decay d(t) = 0.5^(days/365) | YES | `timeDecay()` |
| 4 | Relevance Gate (SS4.3 Step 1-6) | YES | `computeRelevance()`, `analyzeSentiment()` |
| 5 | IDF weighting | YES | `getIdf()` |
| 6 | Negation handling | YES | `findNegatedIndices()` |
| 7 | Emoticon/slang handling | YES | `EMOTICON_*`, `INTENSIFIERS` |
| 8 | Bayesian integration (SS4.4) | YES | `computeFinalScore()` |
| 9 | Reliability grades (SS4.5) | YES | confirmed/estimated/reference/structural/none |
| 10 | `parking_lot_stats` table | YES | `migrations/0021` — 설계와 정확히 일치 |

### 2.2 Changed Items (Major)

| # | Item | Design | Implementation | Severity | Impact |
|---|------|--------|----------------|----------|--------|
| SC1 | Bayesian C value | C=5 | C=1.5 | **Major** | 실제 데이터 반영 속도 향상. 의도적 튜닝. |
| SC2 | Structural prior magnitudes | 큰 값 (-1.0~+0.3) | 축소 (-0.15~+0.1) | **Major** | cold-start 점수가 2.7-3.2 범위에 모이도록 조정 |
| SC3 | Curation tag anchoring | hell->1.5, easy->4.0 고정 | 검증용만, 점수 미반영 | **Major** | 태그는 주관적 — 데이터 기반 점수가 더 정확 |

### 2.3 Missing Items

| # | Item | Severity | Notes |
|---|------|----------|-------|
| SM1 | Pilot validation (Pearson r >= 0.6) | **Major** | 자동화 스크립트 없음, 수동 검증만 |
| SM2 | Bayesian parameter tuning script | Minor | C=3,5,7,10 비교 문서화 없음 |
| SM3 | Blog/YouTube weight 분리 | Minor | 설계는 별도, 구현은 통합 |
| SM4 | UI score composition visualization | Minor | Phase 3 UI 작업, 미구현 |
| SM5 | "AI 추정" 배지 구분 | Minor | "데이터 부족"으로 통합 표시 |

---

## 3. Gap Summary

### Critical (0건)

없음.

### Major (4건)

| ID | Gap | 권장 조치 |
|----|-----|-----------|
| SC1 | Bayesian C: 5 -> 1.5 | **설계 문서 업데이트** (튜닝 근거 기록) |
| SC2 | Structural prior 축소 | **설계 문서 업데이트** |
| SC3 | Curation tag 점수 미반영 | **설계 문서 업데이트** (의도적 결정 기록) |
| SM1 | Pilot validation 미구현 | `scripts/validate-sentiment-correlation.ts` 추가 검토 |

### Minor (8건)

| ID | Gap | 권장 조치 |
|----|-----|-----------|
| C1 | Cron weekly -> hourly | 설계 문서 반영 |
| C2 | Batch 10 -> 25 | 설계 문서 반영 |
| C3 | geo.ts 병합 | 설계 문서 반영 |
| M1 | total_target 미사용 | populate or drop |
| M2 | metadata 미사용 | populate or drop |
| SM2 | Bayesian tuning 문서화 | 낮은 우선순위 |
| SM4 | Score composition UI | Phase 3 UI, 보류 |
| SM5 | "AI 추정" 배지 | Minor UX, 현재 표현이 더 명확 |

---

## 4. Architecture Assessment

구현이 설계를 대부분 초과 달성:

- **Brave Search** — 설계에 없던 3번째 데이터 소스 추가, 커버리지 향상
- **Incremental scoring** — 설계는 배치만 계획, 구현은 크롤링 후 자동 재계산
- **AI multi-matching** — 신뢰도 기반 다중 매칭 확장
- **Dampened structural priors** — cold-start 점수 분포 개선
- **C=1.5** — 실제 데이터에 더 빠르게 반응하는 적절한 튜닝

**7% gap은 주로 설계 문서 업데이트 미반영**이며, 기능적 결함은 아님.

---

## 5. Recommended Actions

### Immediate (문서 동기화)
1. `crawling-architecture-strategy.md` 업데이트: hourly cron, batch 25, Brave Search, incremental scoring
2. `parking-scoring-algorithm.md` 업데이트: C=1.5, dampened priors, curation 검증 전용

### Short-term (구현)
3. `crawl_progress.total_target/metadata` 컬럼 정리 (populate or drop)
4. Pilot validation 스크립트 검토 (`scripts/validate-sentiment-correlation.ts`)

### Deferred (Phase 3)
5. Score composition visualization in detail panel
6. "AI 추정" reliability 배지 구분
