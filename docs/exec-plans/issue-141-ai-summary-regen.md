# 구현 계획: web_sources(matched) ai_summary 재생성 (#141 — Phase D)

> Parent: #138 — Phase D
> Milestone: M9 콘텐츠 보강을 위한 크롤링 파이프라인 개선
> Depends on: #140 (full_text 보강 완료), #148 (filter + relevance v2 통과 subset)

## 요구사항 정리

`web_sources.ai_summary` 22K row 평균 20자 → **full_text 1,400~2,000자 입력으로 재생성**. 이 ai_summary 가 다운스트림 `parking_lot_stats.ai_summary` 와 wiki SSR 콘텐츠의 입력이 된다.

본 이슈는 raw 단계 (`web_sources_raw.ai_summary`) 는 손대지 않는다 — 필터링 결정은 이미 끝났고, 본 이슈는 SEO/콘텐츠 가치 향상이 목적.

### 길이 정책 (2026-05-04 변경)

⚠️ **ai_summary 글자수 하한 가드 제거**. `MIN_SUMMARY_LENGTH=200` 같은 강제 reject 안 함.

이유:
- 길이 압박이 hallucination/패딩 유발 (PR #137 lessons)
- 진짜 양질 후기는 자연스럽게 200~500자 범위. 풀텍스트가 짧거나 정보가 얇은 경우 강제로 200자 채우면 메타 표현/일반론 추가 → SEO 가치 음수.
- #148 필터링이 입력 품질을 이미 보장 (서포터즈/공식 톤 / 본인 경험 없음 = reject)
- 길이는 입력 품질에 자연스럽게 종속 — 양질 입력 → 풍부한 summary, 얇은 입력 → 짧은 summary (그대로 유지)

대신 다음만 강제:
- 본문에 없는 정보 출력 금지 (인용 규율)
- generic safety filler 금지 ("확인 바랍니다", "정보 안내" 등)
- 메타 표현 금지

## 현재 상태 파악

### web_sources.ai_summary

- 22,398 row, 평균 20자
- `match-to-lots.ts:256` 에서 raw.ai_summary 가 그대로 복사됨 → 22K 모두 snippet 기반 빈약 summary
- 실제 가치: `LIKE` 검색 외 거의 없음 (PR #137 회고)

### web_sources.full_text (#140 완료)

- 16,322 row 가 status='ok' (실제 본문 보유)
- naver_blog avg 1,980자 / ddg_search avg 1,336자
- naver_cafe 3,014 row blocked (입력 불가)
- 차단/실패 5,463 row → ai_summary 재생성 대상 아님 (snippet 그대로 유지)

### 살아있는 가드 (PR #137 도입, 본 이슈에서 일부 활용)

- ~~`MIN_SUMMARY_LENGTH=200`~~ → **본 이슈에서 제거** (위 길이 정책 참조)
- 보일러플레이트 reject 패턴 (계속 사용)
- 인용 규율 / 메타 표현 금지 (계속 사용)
- ~~c안 정책 (new>old AND new≥200)~~ → 길이 비교 기준 제거. 단순히 "agent 가 새로 생성한 summary 로 덮어쓰기"
- 본 이슈에서 #148 의 v2 filter 가 reject 한 row 는 ai_summary 재생성 대상에서 제외 (입력 풀 자체에서 빠짐)

## 구현 단계

### Phase D-1 — AI summary 생성기 (matched 전용)

**결정 포인트**: 기존 `ai-filter.ts` SYSTEM_PROMPT 를 재사용 vs 새 프롬프트 작성

기존 `ai-filter.ts` 는 raw 단계 분류 + 짧은 summary 가 목적. 본 이슈는 풍부한 summary 가 목적이므로 다른 프롬프트가 더 적합.

신규 함수: `src/server/crawlers/lib/ai-summary-prompt.ts` 에 `MATCHED_SUMMARY_SYSTEM_PROMPT` 추가 (또는 별도 파일).

프롬프트 골격:
- 입력: full_text (200~50000자) + lot 메타 (name, address)
- 출력: 200~600자 풍부한 SEO 친화 ai_summary (한국어, 경어체)
- PR #137 의 "할루시네이션 절대 금지" / "메타 표현 금지" / generic filler 거부 원칙 계승
- 인용 규율: full_text 에 없는 수치/고유명사 출력 금지

**호출 모드**:
```ts
summarizeMatched(input: {
  full_text: string,
  lot: { name: string; address: string },
  source: 'naver_blog' | 'ddg_search'
}): Promise<{ summary: string; filter_passed: boolean }>
```

`filter_passed=false` 케이스: 본문이 200자 미만 또는 보일러플레이트로 판정되면 ai_summary 갱신 안 함 (기존 snippet 기반 ai_summary 유지).

### Phase D-2 — 재생성 스크립트

신규: `scripts/regen-matched-summaries.ts`

CLI:
- `--remote --source=naver_blog|ddg_search|all`
- `--limit=N` (기본 100)
- `--concurrency=4` (Anthropic 병렬 호출)
- `--batch-size=5` (1 API 호출당 row 수, 프롬프트 캐싱 활용)
- `--shards=N --shard=K` (#140 패턴 재사용)
- `--output-dir=/tmp/summary-out` (SQL 파일 emit)
- `--dry-run`

대상 쿼리:
```sql
SELECT id, source, parking_lot_id, full_text
FROM web_sources
WHERE full_text_status = 'ok'
  AND LENGTH(full_text) >= 200
  AND (ai_summary IS NULL OR LENGTH(ai_summary) < 200)
  AND source IN ('naver_blog','ddg_search')
LIMIT N
```

처리 흐름:
1. 위 쿼리로 대상 row 가져옴
2. lot 메타 lookup (parking_lots JOIN)
3. Anthropic Haiku 호출 (배치 5건/호출)
4. 결과로 SQL UPDATE 생성 (`scripts/fetch-matched-fulltext.ts` 패턴 차용)
5. SQL 파일 chunk emit → 별도 apply 단계

### Phase D-3 — c안 정책 적용

기존 `scripts/apply-summaries.ts` 를 활용하되 **`web_sources` 대상으로 변형 필요**:
- 기존 SQL 패턴: `UPDATE web_sources SET ai_summary = '...' WHERE id = N;` — 본 이슈에서도 그대로 매치
- 신규 옵션: `--target=matched_summary` (단순 라벨링)
- c안 정책: `new.length >= 200 AND (new > old OR old < 200)` — 그대로

### Phase D-4 — A/B 비교 eval

신규 또는 `scripts/eval-` 패턴 차용: `scripts/eval-matched-summaries.ts`

같은 30~50 row 에 대해:
- (old) snippet 기반 ai_summary
- (new) full_text 기반 ai_summary

비교 메트릭:
- 길이 분포 (avg/p25/p50/p75)
- generic filler 비율 (휴리스틱: "확인 바랍니다", "정보 제공" 등 패턴)
- 인용 위반 의심 비율 (full_text 에 없는 한글 명사 N개 이상 등장)
- 수동 검수용 샘플 10 row 출력 → `eval/matched-summary-v2/report.md`

### Phase D-5 — 단계적 실행

| 단계 | 대상 |
|---|---|
| C-1~C-3 구현 + 단위 테스트 | — |
| Pilot | 100 row 검수 (소스 50/50) |
| Eval | 30 row A/B → 통과 게이트 |
| Stage 1 | 1,000 row |
| Stage 2 | 16,322 row 전체 (full_text=ok) |

## 검증

- web_sources.ai_summary 평균: 20자 → ≥ 250자
- 빈값 비율: 99% → < 30%
- Eval pass: filler 비율 < 10%, hallucination 의심 < 5%
- 다운스트림 (#142 lot summary 재생성) 입력 풍부도 향상

## 비용 추정

- 입력: full_text avg 1,500자 ≈ 1,000 input tokens
- 출력: 200~400자 summary ≈ 300 output tokens
- Haiku 4.5: $1/M input + $5/M output → 약 $0.0025/row
- 16K row × $0.0025 = **~$40**
- 프롬프트 캐싱 (system prompt) 적용 시 30~50% 절감 가능

## 의존

- `ANTHROPIC_API_KEY` 환경변수 (`.dev.vars`)
- #140 머지된 main (full_text 컬럼 + 22K 보강 완료)
- `@anthropic-ai/sdk` (이미 의존성에 있음, `scripts/generate-lot-summary.ts` 사용처 참조)

## 리스크

- **MED** — 인용 규율 후퇴: 길이 압박이 hallucination 유발. anti-padding 가드 + eval 게이트 필수.
- **MED** — 보일러플레이트 본문 (광고성 블로그) → summary 도 보일러플레이트. PR #137 reject 패턴 계승.
- **LOW** — Anthropic rate limit: Haiku 빠른 모델, 동시성 4~8 안전.
- **LOW** — 비용 폭주: $40 예산 내, dry-run 우선.

## 후속 (#142 — Phase D)

`scripts/generate-lot-summary.ts` 재실행. 입력이 풍부해진 web_sources.ai_summary 22K → parking_lot_stats.ai_summary 재생성. 최종 wiki SSR 단어수 / Siteliner 중복율 검증.
