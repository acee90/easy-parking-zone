# 구현 계획: raw 단계 fulltext-first 파이프라인 리팩터 (#149)

> Milestone: M10 파이프라인 품질 개선
> Depends on: #139 (full-text fetcher), #140 (fulltext batch), #148 (filter-v2)

---

## 동기

현재 파이프라인은 snippet (~120자)으로 AI 필터를 먼저 돌리고, 매칭 후에 fulltext를 채운다.
문제:
1. snippet 기반 AI 분류는 맥락 부족으로 오분류 발생 → filter_passed_v2로 사후 보정 필요
2. AI 크레딧이 두 번 소비됨 (raw 단계 snippet AI + web_sources 단계 fulltext AI)

개선 목표: **fulltext를 raw 단계에서 먼저 채우고, 3-tier rule로 명백한 고/저 신뢰 row를 AI 없이 분류, medium만 AI 판단**

---

## 현행 파이프라인

```
[크롤링]  web_sources_raw (snippet ~120자)
            ↓ Cron 정각 Step 2
[AI 필터] 100% rows × AI (snippet input)
            ↓ filter_passed=1
[매칭]    web_sources INSERT (full_text_status='pending')
            ↓ Cron 30분 (별도)
[fulltext] web_sources.full_text 보강
            ↓ 수동 batch
[filter-v2] 48% rows × AI (fulltext input) — 사후 보정
```

AI 크레딧 추정: 100 rows → ~100×60 + 48×1000 ≈ **54,000 tokens**

---

## 신규 파이프라인 (목표)

```
[크롤링]  web_sources_raw (snippet ~120자, full_text_status='pending')
            ↓ Cron 30분 Step 1
[fulltext] web_sources_raw.full_text 보강 (crawl4ai)
            ↓ Cron 정각 Step 2
[rule filter] high → auto-pass / low → auto-reject (AI 없음)
              medium → AI (fulltext input)
            ↓ filter_passed=1
[매칭]    web_sources INSERT (full_text 복사, full_text_status='ok')
            ↓ Cron 정각 Step 4
[스코어링] parking_lot_stats UPSERT
```

AI 크레딧 추정: 100 rows → ~20×1000 ≈ **20,000 tokens (63% 절감)**
(medium 비율 20% 가정 — 실측 후 보정)

---

## 3-tier Rule 기준

### High (auto-pass, AI 없음)

full_text_status='ok' AND full_text ≥ 500자 AND 다음 중 2개 이상:
- 입차 / 출차 / 정산 / 정산기 / 무인정산
- 주차면 / 총 N면 / 경차전용 / 장애인 전용
- 기계식 / 높이제한 / 지하 / 옥상 / 지상
- 정기권 / 월정액 / 무제한
- 만차 / 빈자리 / 잔여

→ `filter_passed=1, filter_tier='high'` (AI 호출 없음, ai_summary=NULL)

### Low (auto-reject, AI 없음)

다음 중 1개라도 해당:
- `full_text_status != 'ok'` (blocked/not_found/too_short/error)
- full_text 길이 < 200자
- 부동산 키워드: 매매 / 전세 / 분양 / 임대 / 평형
- 행사 키워드: 결혼식 / 돌잔치 / 장례 / 웨딩홀

→ `filter_passed=0, filter_tier='low'` (AI 호출 없음)

### Medium (AI 판단)

high / low 어디에도 해당 안 되는 나머지

→ AI (Haiku) 호출, fulltext input (~2,000자), 기존 output schema 동일
  (filter_passed, sentiment_score, ai_difficulty_keywords, ai_summary, tip_*)

---

## 구현 단계

### Phase A — Schema migration

신규: `migrations/0040_raw_fulltext.sql`

```sql
ALTER TABLE web_sources_raw ADD COLUMN full_text TEXT;
ALTER TABLE web_sources_raw ADD COLUMN full_text_status TEXT DEFAULT 'pending';
ALTER TABLE web_sources_raw ADD COLUMN full_text_fetched_at TEXT;
ALTER TABLE web_sources_raw ADD COLUMN filter_tier TEXT; -- 'high'|'medium'|'low'

CREATE INDEX idx_raw_fulltext_status ON web_sources_raw(full_text_status, ai_filtered_at);
```

- `filter_tier` 컬럼: rule 분류 결과 기록 (디버깅·통계용)
- 기존 row (`ai_filtered_at IS NOT NULL`): 신규 컬럼은 NULL로 유지, 재처리 안 함

### Phase B — Raw fulltext batch 모듈

신규: `src/server/crawlers/raw-fulltext-batch.ts`

- `fulltext-batch.ts` (web_sources용)와 동일 로직, 대상 테이블만 다름
- 쿼리: `web_sources_raw WHERE full_text_status='pending' AND source IN ('naver_blog','naver_cafe','ddg_search','brave_search')`
- UPDATE: `raw.full_text`, `raw.full_text_status`, `raw.full_text_fetched_at`
- BATCH_LIMIT: 25 (Cron 30초 wall time)

> `fulltext-batch.ts`의 공통 로직은 `lib/fulltext-fetcher-runner.ts`로 추출해 두 파일이 공유하는 방향 고려.

### Phase C — Rule filter 모듈

신규: `src/server/crawlers/lib/rule-filter.ts`

```typescript
export type FilterTier = 'high' | 'medium' | 'low'

export interface RuleFilterInput {
  fullText: string | null
  fullTextStatus: string | null
}

export function classifyByRule(input: RuleFilterInput): FilterTier
```

- `low` 조건을 먼저 체크 (fast-fail)
- `high` 조건 체크
- 나머지 `medium`
- 순수 함수 → 단위 테스트 작성 필수

### Phase D — AI filter 수정

파일: `src/server/crawlers/ai-filter-batch.ts`

변경:
1. 쿼리 조건 추가: `ai_filtered_at IS NULL AND full_text_status = 'ok'`
   - fulltext 미완료 row는 건너뜀 (다음 cron tick에서 처리)
2. 배치 처리 전 rule filter 선적용:
   - high → `UPDATE SET filter_passed=1, filter_tier='high', ai_filtered_at=now()` (AI 없음)
   - low → `UPDATE SET filter_passed=0, filter_tier='low', ai_filtered_at=now()` (AI 없음)
   - medium만 기존 `classifyBatch()` 호출
3. AI 입력 변경: `description: s.content` → `description: (s.full_text ?? s.content).slice(0, 2000)`
4. 프롬프트 교체 (`ai-summary-prompt.ts`): filter-v2 판정 기준을 통합한 새 프롬프트로 교체

#### 신규 프롬프트 설계 (filter-v2 + summary 통합)

**기존 ai-filter 프롬프트와 filter-v2 프롬프트의 차이:**

| 항목 | 기존 ai-filter | filter-v2 | 신규 (통합) |
|------|--------------|-----------|------------|
| 입력 | snippet ~120자 | fulltext + lot_name | fulltext (lot_name 없음¹) |
| removed_by 종류 | 4종 (ad/realestate/irrelevant/news) | 7종 (+thin/wrong_lot/boilerplate) | 6종 (+thin/boilerplate, wrong_lot 제외¹) |
| summary 출력 | 필수 (200~600자) | 없음 | filter_passed=true시만 생성 |
| tip 출력 | 있음 | 없음 | filter_passed=true시만 생성 |

> ¹ **wrong_lot 미적용 이유**: raw 단계에서는 아직 매칭 전이므로 lot_name 컨텍스트 없음.
> wrong_lot 케이스는 매칭 단계(FTS5)에서 자연스럽게 미매칭으로 처리됨.

**신규 프롬프트 출력 스키마:**
```json
{
  "filter_passed": true/false,
  "removed_by": null 또는 "ad"/"realestate"/"irrelevant"/"news"/"thin"/"boilerplate",
  "sentiment_score": 1.0~5.0,
  "difficulty_keywords": ["좁다", "기계식"],
  "summary": "200~600자 또는 '' (filter_passed=false시 빈 문자열)",
  "tip_pricing": "...",
  "tip_visit": "...",
  "tip_alternative": "..."
}
```

**filter_passed=false 시 규칙** (output 토큰 절감):
- `summary = ''`, `tip_* = null` 출력 지시
- rejected row output 토큰: ~800 → ~50

인터페이스 변경: `AiFilterResult.filterRemovedBy` 타입에 `'thin' | 'boilerplate'` 추가.

### Phase E — 매칭 모듈 수정

파일: `src/server/crawlers/match-to-lots.ts`

변경:
1. `RawRow` 인터페이스에 `full_text`, `full_text_status`, `full_text_fetched_at` 추가
2. SELECT 쿼리에 해당 컬럼 추가
3. `buildInsert()` 수정:
   ```sql
   INSERT INTO web_sources (..., full_text, full_text_length, full_text_status, full_text_fetched_at)
   VALUES (..., ?14, ?15, ?16, ?17)
   ```
   - raw의 fulltext를 그대로 복사
   - `full_text_status='ok'` 세팅 (별도 pending 큐잉 불필요)

### Phase F — Cron 순서 재편

파일: `src/server/scheduled.ts`

**매시 정각 (handleScheduled)**:
```
1. 크롤링 → web_sources_raw
2. raw fulltext batch  ← NEW (rawFullTextBatch, BATCH_LIMIT=25)
3. AI filter (rule 선분류 + medium만 AI)
4. 주차장 매칭 → web_sources (full_text 복사)
5. 스코어링 재계산
```

**매시 30분 (handleDdgScheduled)**:
```
1. DDG 크롤링
2. raw fulltext batch (DDG raw rows)  ← 기존 fullTextBatch 대체
```

> 기존 `fulltext-batch.ts` (web_sources용)는 레거시 row 백필용으로 유지.
> 신규 matched row는 full_text가 이미 채워진 채로 INSERT되므로 pending 큐잉 없음.

### Phase G — 파이프라인 커맨드 추가

#### 설계 원칙

모든 배치 작업은 3단계 템플릿을 따른다:

```
1. Dump    : remote D1 → 로컬 스냅샷 (선택적)
2. Process : 스테이지 스크립트 실행 → /tmp/pipeline-{stage}-{ts}/*.sql emit
3. Apply   : SQL 청크 파일 remote D1 apply → 중간 파일 정리
```

중단 후 재개:
- 상태 컬럼(`full_text_status`, `ai_filtered_at`, `matched_at`)이 미처리 row를 추적
- emit된 SQL 청크 파일은 apply 전까지 `/tmp/`에 유지 → 재실행 시 감지해서 이어서 apply

#### 신규 파일: `.claude/commands/run-pipeline.md`

스테이지별 실행 커맨드:

```
/run-pipeline [stage] [options]

stage:
  fulltext   raw fulltext 보강 (raw-fulltext-batch)
  filter     rule + AI filter (ai-filter-batch)
  match      주차장 매칭 (match-to-lots)
  scoring    스코어링 재계산
  all        fulltext → filter → match → scoring 순차 실행

options:
  --remote         remote D1에 직접 apply
  --dry-run        SQL emit만, apply 생략
  --keep-artifacts 완료 후 /tmp SQL 파일 유지
  --resume         기존 /tmp SQL 파일 감지 시 apply부터 재개
```

커맨드 파일은 각 스테이지를 subagent로 실행하고, SQL emit → apply → 정리 흐름을 오케스트레이션.

#### 기존 커맨드 파일 업데이트

| 파일 | 조치 |
|------|------|
| `.claude/commands/batch-ai-filtering.md` | deprecated 주석 추가 → `run-pipeline filter` 사용 안내 |
| `.claude/commands/ai-summary.md` | 내용 검토 후 run-pipeline 참조로 통합 여부 결정 |

#### 신규 에이전트: `.claude/agents/pipeline-runner.md`

파이프라인 스테이지 실행 전담 에이전트:
- 스테이지 실행 전 `/tmp/pipeline-{stage}-*/` 디렉토리 확인 (resume 감지)
- SQL 청크 파일 순차 apply 후 apply 결과 로그
- 완료 후 산출물 정리

---

## filter_passed_v2 처리 방침

- **신규 row**: 새 파이프라인이 fulltext 기반 필터를 처음부터 적용하므로 `filter_passed_v2` 불필요
- **기존 row**: `filter_passed_v2` 데이터 유지 (스키마 변경 없음)
- `filter_passed_v2` 컬럼은 스키마에서 제거하지 않고 deprecated 처리 (별도 cleanup 이슈)

---

## AI 크레딧 절감 검증

Phase D 완료 후 첫 1주일 운영 데이터로 측정:

| 지표 | 목표 |
|------|------|
| medium 비율 | ≤ 30% |
| filter_passed 정밀도 | ≥ 기존 수준 (filter_passed_v2 PASS율 비교) |
| ai_summary non-null 비율 (web_sources) | ≥ 70% (medium만 생성) |

medium 비율이 50% 초과하면 high/low rule 기준 재조정.

---

## 리스크

| 수준 | 내용 | 대응 |
|------|------|------|
| MED | high rule 과도 통과 (false positive) | rule 기준 보수적으로 초기 설정, 1주 후 샘플 감사 |
| MED | fulltext 미완료 row 누적 (크롤링 > fulltext 처리량) | BATCH_LIMIT 조정, DDG cron raw fulltext 병행 |
| LOW | naver_cafe blocked row AI 불필요 호출 | full_text_status 조건으로 자동 차단 (Phase D Step 1) |
| LOW | 기존 raw row 재처리 혼선 | `ai_filtered_at IS NOT NULL` 조건으로 기존 row 건너뜀 |

---

## 구현 순서 및 완료 기준

| Phase | 파일 | 완료 조건 |
|-------|------|-----------|
| A | `migrations/0040_raw_fulltext.sql` | remote D1 적용 완료 |
| B | `src/server/crawlers/raw-fulltext-batch.ts` | smoke: naver_blog 5건 ok |
| C | `src/server/crawlers/lib/rule-filter.ts` | 단위 테스트 ≥ 10케이스 통과 |
| D | `ai-summary-prompt.ts` + `ai-filter-batch.ts` | medium 비율 로그 확인, thin/boilerplate removed_by 확인 |
| E | `match-to-lots.ts` | web_sources INSERT 후 full_text non-null 확인 |
| F | `scheduled.ts` | cron 1회 실행 로그 정상 |
| G | `.claude/commands/run-pipeline.md` + `.claude/agents/pipeline-runner.md` | `/run-pipeline filter --dry-run` 실행 확인 |

---

## 관련 파일

| 파일 | 변경 여부 |
|------|-----------|
| `src/server/scheduled.ts` | 수정 |
| `src/server/crawlers/ai-filter-batch.ts` | 수정 |
| `src/server/crawlers/lib/ai-summary-prompt.ts` | 수정 (filter-v2 기준 통합) |
| `src/server/crawlers/lib/ai-filter-v2-prompt.ts` | deprecated (신규 프롬프트로 통합) |
| `src/server/crawlers/match-to-lots.ts` | 수정 |
| `src/server/crawlers/fulltext-batch.ts` | 유지 (레거시 백필용) |
| `src/server/crawlers/raw-fulltext-batch.ts` | 신규 |
| `src/server/crawlers/lib/rule-filter.ts` | 신규 |
| `migrations/0040_raw_fulltext.sql` | 신규 |
| `.claude/commands/run-pipeline.md` | 신규 |
| `.claude/agents/pipeline-runner.md` | 신규 |
| `.claude/commands/batch-ai-filtering.md` | deprecated 처리 |
