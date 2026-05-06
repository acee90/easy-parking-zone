---
description: web_sources.ai_summary 작성·재생성 — 기본 모드(매칭 후 재생성) + --raw 모드(신규 크롤 분류). 사양은 src/server/crawlers/lib/ai-summary-prompt.ts single source of truth.
---

# regen-web-summary

이슈 #135 워크플로우. raw 단계와 매칭 후 재생성 양쪽 진입점.

## 사양 source of truth

**프롬프트 사양은 코드에 있음**: `src/server/crawlers/lib/ai-summary-prompt.ts` → `AI_SUMMARY_SYSTEM_PROMPT`.
raw 단계(코드 직접 호출)와 매칭 후 재생성(agent 호출) 모두 동일 사양.

## 모드 1: 매칭 후 재생성 (기본)

기존 `web_sources` 저품질 ai_summary를 lot-specific long-form으로 갱신. agent 호출.

### 인자
| 인자 | 기본값 | 설명 |
|------|--------|------|
| `--limit-lots N` | 모든 lot | 처리할 lot 수 (web_sources 풍부도 순) |
| `--top-n N` | 5 | lot당 상위 몇 개 |
| `--lot-id ID` | (없음) | 특정 lot만 |
| `--source-whitelist` | tistory_blog,naver_place | 허용 source (콤마구분, `all`로 전체 허용) |
| `--remote` | local | remote D1 사용 |

### 워크플로우
1. `bun run scripts/extract-top-sources-by-lot.ts <flags>` → `data/top-sources-by-lot.json`
2. `ai-summary-generator` agent 호출 → `data/top-sources-by-lot.sql`
   - agent는 첫 단계로 `src/server/crawlers/lib/ai-summary-prompt.ts`를 Read하여 사양 확보
3. `bun run scripts/apply-summaries.ts --input data/top-sources-by-lot.sql [--remote] [--apply]` → c안 정책 적용
4. `bunx wrangler d1 execute parking-db --remote --file data/regen-applied.sql` (수동)

### 예시
```
/regen-web-summary --limit-lots 10 --top-n 5 --remote
```

## 모드 2: raw 단계 (`--raw`)

신규 크롤된 `web_sources_raw`를 분류 + ai_summary 작성. `scripts/filter-web-sources.ts` 호출 (high/medium/low 3-tier, medium은 Haiku AI 평가).

### 인자
| 인자 | 기본값 | 설명 |
|------|--------|------|
| `--raw` | (필수) | raw 모드 활성화 |
| `--limit N` | 100 | 처리할 미분류 row 수 |
| `--remote` | local | remote D1 사용 |
| `--dry-run` | (없음) | API만 호출, DB 저장 안함 |

환경변수 `ANTHROPIC_API_KEY` 필요.

### 워크플로우
```bash
ANTHROPIC_API_KEY=sk-ant-... bun run scripts/filter-web-sources.ts [--remote] [--limit N] [--dry-run]
```

같은 SYSTEM_PROMPT를 사용하므로 raw → web_sources로 승격되는 row의 ai_summary는 본 워크플로우의 매칭 후 재생성과 일관된 long-form.

### 예시
```
/regen-web-summary --raw --limit 100 --remote
```

## 보고 형식

### 기본 모드
```
=== web_sources ai_summary 재생성 (regen) ===
Step 1 추출: <후보 row>건 (lot <개수>개)
       source 분포: ...
Step 2 agent: <처리>건, <빈 문자열>건
       평균 길이: <자>
Step 3 적용: <적용>건 / <거부>건
       거부 사유: too_short=<N>, not_better=<N>
샘플: ...
```

### raw 모드
```
=== web_sources_raw 분류 (raw) ===
처리: <건수>
통과: <건수>
제거: <건수> (광고/short_summary/...)
샘플: ...
```

## 파일럿 권장

처음 실행 시 작은 배치:

```
/regen-web-summary --limit-lots 10 --top-n 5 --remote        # 매칭 후 (50 row 정도)
/regen-web-summary --raw --limit 50 --remote --dry-run       # raw (50 row, dry-run)
```

검증:
- regen-rejected 비율 < 30%
- 200자 이상 비율 > 70%
- 통과한 결과 샘플 5건 수동 검토

OK면 limit 단계적 확대.
