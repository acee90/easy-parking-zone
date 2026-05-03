# 크롤링 파이프라인 v2 — 현행 아키텍처

> 최초 작성: 2026-03-13 | 현행화: 2026-05-03 (#140 풀텍스트 보강 단계 추가)

## 목적

웹 콘텐츠(블로그/카페/YouTube/검색엔진)에서 **주차장 관련 정보**를 자동 수집하여,
주차장별 난이도 점수에 반영한다.

## 2-테이블 구조

```
web_sources_raw (원본 + 필터링, content = snippet 121자)
  ↓ AI 필터 통과 + 주차장 매칭 완료
web_sources (검증된 데이터만, full_text 1,400~2,000자 — #140 이후)
```

- **`web_sources_raw`**: 크롤링 원본 저장. `filter_passed`, `matched_at` 등 파이프라인 상태 관리. `content` = Naver/DDG 검색 API 의 `description` 스니펫 (~120자).
- **`web_sources`**: 필터 + 매칭 통과분. `full_text` (#140 풀텍스트 fetcher 로 보강), `full_text_status` (pending/ok/blocked/not_found/too_short/timeout/error), `full_text_fetched_at` 컬럼 보유.
- **풀텍스트 보강 (#140, 2026-05-03)**: matched 22K row 의 `full_text` 를 batch fetch로 채움. naver_blog 9,078 ok (avg 1,980자), ddg_search 7,244 ok (avg 1,336자), naver_cafe 3,014 blocked:spa_shell. 신규 매칭 row 는 자동 `pending` 으로 큐잉, 주기적 batch 가 픽업.

---

## Workers Cron 파이프라인

`src/server/scheduled.ts` — 매시간 자동 실행. 4단계 순차 처리.

```
┌─────────────────────────────────────────────────┐
│ Cron: 매시 정각 (0 */1 * * *)                     │
│                                                   │
│  1. 크롤링 → web_sources_raw                      │
│     ├ 네이버 블로그/카페 (naver-blogs.ts)           │
│     ├ YouTube 미디어+댓글 (youtube.ts)              │
│     └ Brave Search (brave-search.ts)               │
│                                                   │
│  2. AI 필터 (ai-filter-batch.ts)                  │
│     └ 미분류 raw → Haiku 10건 배치 × 5 병렬        │
│       → filter_passed / sentiment_score 등 업데이트 │
│                                                   │
│  3. 주차장 매칭 (match-to-lots.ts)                 │
│     └ filter_passed=1 & 미매칭 raw                 │
│       → FTS5 후보 검색 → 신뢰도 판정               │
│       → high: 바로 web_sources INSERT              │
│       → medium: AI 검증 후 INSERT                  │
│       → low/none: 스킵                             │
│                                                   │
│  4. 스코어링 재계산 (scoring-engine.ts)             │
│     └ 최근 2시간 내 매칭된 주차장 대상              │
│                                                   │
├─────────────────────────────────────────────────┤
│ Cron: 매시 30분 (30 */1 * * *)                    │
│                                                   │
│  DDG 크롤링 (duckduckgo-search.ts)                │
│  └ subrequest 한도 분리 위해 별도 cron              │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│ 외부 (수동/cron host) — #140 추가                  │
│                                                   │
│  5. 풀텍스트 보강 (fetch-matched-fulltext.ts)      │
│     └ web_sources WHERE full_text_status='pending' │
│       → fetchFullText() 호출 (naver_blog/cafe/ddg) │
│       → 결과를 SQL 파일로 emit (1000건/file)        │
│       → wrangler d1 execute --file 로 일괄 적용     │
│                                                   │
│  Worker 비호환 (jsdom/readability) → Cron 외부 실행 │
└─────────────────────────────────────────────────┘
```

---

## 각 단계 상세

### 1. 크롤링 → web_sources_raw

| 크롤러 | 파일 | 소스 | 비고 |
|--------|------|------|------|
| 네이버 블로그/카페 | `naver-blogs.ts` | Naver Search API | 주차장명 기반 검색 |
| YouTube | `youtube.ts` | YouTube Data API | 미디어 + 댓글 수집 |
| Brave Search | `brave-search.ts` | Brave Search API | 일 1회 제한 |
| DuckDuckGo | `duckduckgo-search.ts` | Crawl4AI → DDG | 별도 cron, subrequest 분리 |

- 모든 크롤러는 `web_sources_raw`에 `INSERT OR IGNORE` (source_id 중복 방지)
- 이 단계에서는 필터링/매칭 없이 원본만 저장

### 2. AI 필터 (Haiku 배치 분류)

**파일**: `src/server/crawlers/ai-filter-batch.ts` + `lib/ai-filter.ts`

- 1회 cron당 최대 100건 (Free plan 30초 wall time 제한)
- 10건 배치 × 5 병렬 = 50건/라운드
- Haiku가 판정하는 항목:
  - `filter_passed`: 주차 관련 유용한 정보 여부
  - `filter_removed_by`: 미통과 사유 (ad/realestate/irrelevant/news/monthly/wedding)
  - `sentiment_score`: 초보 관점 주차 용이성 (1.0~5.0)
  - `ai_difficulty_keywords`: 난이도 키워드 배열
  - `ai_summary`: 한줄 요약 (20자 이내)

> **is_ad 필터 제거 경위**: 500건 파일럿에서 is_ad가 유효한 주차 글 10건을 오분류(FN).
> AI 필터가 광고/부동산/무관 콘텐츠를 더 정확하게 분류하므로 is_ad 컬럼 자체를 제거함.

### 3. 주차장 하이브리드 매칭

**파일**: `src/server/crawlers/match-to-lots.ts`

1회 cron당 최대 50건. `filter_passed=1 AND matched_at IS NULL`인 raw 대상.

```
raw 소스 1건
  ↓ 제목+본문에서 키워드 추출 (불용어 제거, 최대 5개)
  ↓ FTS5 검색 (parking_lots_fts) → 후보 최대 20개
  ↓ LIKE 폴백 (FTS 결과 3개 미만 시)
  ↓ 후보별 신뢰도 판정 (getMatchConfidence)
  ├ high → 바로 web_sources INSERT
  ├ medium → Haiku AI 검증 → 통과 시 INSERT
  └ low/none → 스킵
  ↓ matched_at 업데이트 (재처리 방지)
```

- `web_sources` INSERT 시 `raw_source_id`로 원본 연결
- 1 source → N 주차장 관계 지원 (source_id에 lot_id 접미사)

### 4.5. 풀텍스트 보강 (#140, 외부 batch)

**파일**: `scripts/fetch-matched-fulltext.ts` + `src/server/crawlers/lib/full-text-fetcher.ts`

기존 `web_sources_raw.content` 와 그로부터 복사된 `web_sources.content` 는 검색 API의 description 스니펫 (~120자) — AI 필터/요약/SEO에 부족한 길이. 본 단계에서 **matched row 의 source_url을 다시 fetch 해 본문 풀텍스트를 `web_sources.full_text` 에 저장**.

| source | 추출기 | 평균 본문 | 성공률 (public) |
|---|---|---:|---:|
| naver_blog | iframe → `.se-main-container` / `.post-view` / `#postViewArea` (cheerio) | 1,980자 | 96.7% |
| naver_cafe | SPA 전환됨 → `blocked:spa_shell` 분류 | n/a | 0% |
| ddg_search | jsdom + Mozilla Readability + cheerio fallback | 1,336자 | 83.4% |

가드:
- `MIN_TEXT_LENGTH=200` 미만 → `too_short`
- PDF / binary 응답 (`%PDF-`, `%%EOF`) → `error:binary_document`
- 단일 UPDATE > 50KB → `error` (D1 SQLITE_TOOBIG 회피)

운영:
- 신규 매칭 row 는 자동 `full_text_status='pending'` (스키마 default)
- 주기적으로 외부 host 또는 수동으로 batch 실행
- 멀티-shard 병렬화: `--shards=N --shard=K` (모듈로 분할)

문서: `docs/exec-plans/issue-140-fulltext-batch.md`, `data/fulltext-batch-report.md`

### 4. 스코어링 재계산

**파일**: `src/server/crawlers/lib/scoring-engine.ts`

최근 2시간 내 매칭된 주차장만 대상으로 `parking_lot_stats` 재계산.

가중치:
```
user_review: 0.50  (사용자 직접 리뷰, 5점 척도)
text:        0.50  (모든 텍스트 소스 통합, 감성×관련도 가중 평균)
```

Bayesian 통합: structural_prior(3.0) 기반, n_effective로 신뢰도 산출.

---

## 데이터 흐름 요약

```
[크롤러]   → web_sources_raw  (snippet 121자, INSERT OR IGNORE)
              ↓
[AI 필터]  → filter_passed=1/0, sentiment_score, ai_summary(~21자) 업데이트
              ↓ (filter_passed=1 & matched_at IS NULL)
[매칭]     → web_sources INSERT (raw_source_id FK, ai_summary 복사)
              ↓ (외부 batch — #140)
[풀텍스트] → web_sources.full_text (1,400~2,000자, ok rows)
              ↓ (#148 — 예정)
[재필터]   → filter_passed_v2 / relevance_score_v2 (full_text 입력 재평가)
              ↓ (#141 — 예정)
[재요약]   → web_sources.ai_summary 재생성 (full_text 입력, 200자+)
              ↓ (최근 매칭 주차장)
[스코어링] → parking_lot_stats UPSERT
```

---

## 관련 파일

| 파일 | 역할 |
|------|------|
| `src/server/scheduled.ts` | Cron 핸들러 (오케스트레이션) |
| `src/server/crawlers/naver-blogs.ts` | 네이버 블로그/카페 크롤러 |
| `src/server/crawlers/youtube.ts` | YouTube 크롤러 |
| `src/server/crawlers/brave-search.ts` | Brave Search 크롤러 |
| `src/server/crawlers/duckduckgo-search.ts` | DDG 크롤러 (별도 cron) |
| `src/server/crawlers/ai-filter-batch.ts` | AI 필터 배치 |
| `src/server/crawlers/lib/ai-filter.ts` | AI 필터 모듈 (Haiku 프롬프트) |
| `src/server/crawlers/lib/full-text-fetcher.ts` | **#139** 풀텍스트 fetcher (naver_blog/cafe/ddg) |
| `src/server/crawlers/match-to-lots.ts` | 주차장 하이브리드 매칭 |
| `src/server/crawlers/lib/scoring.ts` | 관련도 채점 + 신뢰도 판정 |
| `src/server/crawlers/lib/scoring-engine.ts` | 통합 스코어링 엔진 |
| `src/server/crawlers/lib/sentiment.ts` | 감성 분석 (룰 기반) |
| `scripts/fetch-matched-fulltext.ts` | **#140** 풀텍스트 batch (외부 실행) |
| `scripts/clean-pdf-updates.ts` | #140 1회용 PDF UPDATE cleaner |
| `scripts/compute-parking-stats.ts` | 전체 배치 스코어링 재계산 |

---

## 파일럿 히스토리

<details>
<summary>Phase 1~1.5 파일럿 결과 (2026-03-13 완료)</summary>

### Phase 1: 매칭 로직 파일럿

80개 POI 블로그 샘플로 키워드 매칭 vs AI 매칭(Haiku) 비교.

| 지표 | AI 매칭 | 키워드 매칭 |
|------|---------|------------|
| 매칭 성공률 | **71%** (57/80) | 60% (48/80) |
| 총 매칭 건수 | 89건 (블로그당 1.6개) | 197건 (블로그당 4.1개) |
| 정밀도 | **~95%** | **~30~40%** (과매칭) |

결론: 키워드 매칭은 필터용, 최종 매칭은 AI(Haiku) 담당.

### Phase 1.5: 필터링 파일럿

500건 확대 검증, 3개 설정 비교:

| 설정 | Precision | Recall | F1 |
|------|-----------|--------|-----|
| v1: is_ad + 주차키워드 | 79.9% | 89.9% | 84.6% |
| **v2: 제외키워드 + 주차키워드** | **83.4%** | **90.3%** | **86.7%** |
| v3: is_ad + 제외키워드 | 83.9% | 86.2% | 85.0% |

채택: v2 (is_ad 필터 제거, 제외 키워드 기반) → 이후 AI 필터로 완전 대체.

### 파일럿 산출물

| 파일 | 내용 |
|------|------|
| `scripts/pilot-poi-fulltext.ts` | 원문 수집 + 키워드 매칭 파일럿 |
| `scripts/pilot-poi-ai-match.ts` | AI 매칭 파일럿 (Haiku) |
| `scripts/pilot-filter.ts` | 필터링 v1 파일럿 (80건) |
| `scripts/pilot-filter-v2-collect.ts` | 필터링 v2 수집 (500건) |
| `scripts/pilot-filter-v2-eval.ts` | 필터링 v2 평가 |

</details>
