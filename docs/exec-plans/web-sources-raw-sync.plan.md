# web_sources_raw ↔ web_sources Sync — 2026-05-14

> **목표 (사용자 정의)**
> 1. `web_sources_raw`에 fulltext를 전부 채워 넣고, **최신 ai-filter v3 (run-pipeline의 Stage 3)** 기준으로 평가
> 2. v3 통과된 것만 `web_sources`에 최신화 (summary/sentiment 포함)
> 3. 최종 상태:
>    - **raw**: fulltext + filter 결과 보유 (마스터)
>    - **ws**: passed된 것만 존재, raw_source_id FK로 raw 가리킴, summary/sentiment_score를 ws가 보유

---

## 현황 (2026-05-14, 1K 파일럿 + 전체 backfill 후)

### web_sources_raw (마스터)

| 분류 | 건수 | fulltext ok | 비고 |
|---|---:|---:|---|
| 옛 raw (원래 데이터) | 23,826 | 23,797 (99.9%) | `filter_passed=1` (v1 기준, 모두 통과로 마킹) |
| backfill raw (옛 ws에서 옮긴 것) | 12,321 | 11,610 (94.2%) | `filter_passed=NULL`, fulltext c4ai로 fetch 완료 |
| **합계** | **36,147** | **35,407 (97.9%)** | |

### web_sources (미러)

| 컬럼 | 채워진 건 |
|---|---:|
| 전체 ws | 22,611 |
| raw_source_id 채워짐 | 21,875 (96.7%) |
| filter_passed_v2=1 (현재) | 3,816 |
| ai_summary ≥ 200자 (현재) | 666 |
| sentiment_score NOT NULL | 8,461 |

> 1K 파일럿 (raw backfill 12K 중 ws-fan-out 1,000건)에서 365건 passed → ws에 UPDATE 완료.

---

## 정상 흐름 (Sync 작업 정의)

```
[raw 마스터]
  ↓ fulltext (이미 채워짐, 35,407 ok)
  ↓
[Stage 3 v3 AI filter] — pipeline-ai-filter subagent
  ↓ (raw_id, lot_id) 단위 평가 → ai-results.json
  ↓
[raw에 평가 결과 저장]
  ↓ raw.filter_passed / sentiment_score / ai_difficulty_keywords / filter_removed_by / ai_filtered_at
  ↓ (※ lot-agnostic 컬럼만, 한 raw가 여러 lot에 다른 결과면 첫 결과 사용)
  ↓
[ws에 sync]
  ↓ raw_source_id JOIN으로
  ↓ passed (filter_passed=1)인 (raw_id, lot_id) → ws.filter_passed_v2=1, ai_summary(lot-specific), sentiment_score, ai_difficulty_keywords
  ↓ failed인 (raw_id, lot_id) → ws.filter_passed_v2=0, ai_summary=""
```

핵심 원칙:
- **raw가 master**: fulltext와 lot-agnostic 필터 결과를 보유.
- **ws는 raw의 미러 + lot-specific summary**: 모든 ws는 raw에 대응 row가 있어야 (raw_source_id 채워짐).
- **passed인 raw는 모두 ws에 매핑되어야**: ws에 없는 passed raw가 있으면 매칭/INSERT 필요.

---

## Phase 구분 (재구성)

### Phase A — raw에 fulltext 전부 채우기 ✅ (이미 완료)

- 옛 raw 23,826: full_text_status='ok' 23,797 (#140 fulltext fetch에서 채워짐)
- backfill raw 12,321: c4ai로 fetch 완료 (ok 11,610)
- 합계 35,407 ok / 740 실패 (error/too_short/etc, 데이터 한계)

### Phase B — 1K 파일럿 ai-filter (이미 완료)

- backfill raw 중 1,000건 ws-level 평가 → 365 passed (37.4%)
- 결과: `data/sync-pilot/merged.json`

### Phase C — 1K 파일럿을 raw + ws에 정식 sync (이번 작업)

목표: 파일럿 결과를 정석 흐름대로 다시 적용.

C-1. **ai-results → raw UPDATE**
- raw.filter_passed (boolean → 0/1)
- raw.filter_removed_by
- raw.sentiment_score
- raw.ai_difficulty_keywords (JSON string)
- raw.ai_filtered_at = datetime('now')

C-2. **raw → ws sync (raw_source_id JOIN)**
- ws.filter_passed_v2 = raw.filter_passed
- ws.filter_v2_reason = raw.filter_removed_by
- ws.sentiment_score = raw.sentiment_score
- ws.ai_difficulty_keywords = raw.ai_difficulty_keywords
- ws.ai_summary = (lot-specific from ai-results, NOT from raw)
- ws.filter_v2_evaluated_at = datetime('now')

C-3. 검증: raw에서 passed된 (raw_id, lot_id)가 모두 ws에 존재하는지

### Phase D — 나머지 raw 전체 v3 평가 (큰 작업)

- 대상: ai_filtered_at IS NULL인 raw + 옛 raw 중 v3 재평가 필요분
- 핵심: backfill raw 11,610 중 1,000 처리됨 → **남은 10,610 raw + ws fan-out ≈ 16K**
- 옛 raw 23,797: 옛 ws에 매핑되어 이미 v2 결과 있음. 재평가 여부 사용자 결정 필요.
- subagent 호출 16K~40K (chunk 50건씩 320~800 chunks)
- 시간: chunk당 1-3분 × 병렬 5개 → 10~30시간 (백그라운드)

### Phase E — 정합성 검증

- raw passed → 모든 (raw_id, lot_id) 쌍이 ws에 존재
- raw failed → ws.filter_passed_v2=0 또는 ws에서 제거
- 무결성: ws.raw_source_id가 raw.id를 가리키지 않는 dangling 없음

### Phase F — Remote 반영

- Phase C, D 결과 SQL을 remote D1에 일괄 적용

---

## 결정 필요 사항

1. **옛 raw 23,797 재평가?**
   - 옵션 α: 재평가 (v3 일관성) — 큰 비용
   - 옵션 β: 옛 raw의 v1 filter_passed=1 그대로 신뢰, 새 backfill만 v3 평가

2. **Phase D 진행 시점**
   - C 완료 후 즉시
   - 또는 작은 batch (예: 5K)로 점진 확대

3. **eval 시점**
   - C 완료 후 eval (작은 표본으로 정밀도 확인)
   - 또는 D까지 끝낸 후 한 번에 eval

---

## 산출물

- `scripts/apply-ai-results-to-raw.ts` (신규, C-1)
- `scripts/sync-raw-to-ws.ts` (신규, C-2)
- 또는 통합 `apply-sync-ai-results-v2.ts`

## 관련 문서

- [scheduler-pipeline.md](../references/scheduler-pipeline.md)
- `.claude/commands/run-pipeline.md`
- `.claude/agents/pipeline-ai-filter.md`
