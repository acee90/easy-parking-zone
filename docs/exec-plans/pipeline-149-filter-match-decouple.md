# #149 파이프라인 — filter / match 관심사 분리

> 목표: AI filter는 "주차 양질 콘텐츠인가"만 판단하고, "어느 lot인가"는 match 단계로 일임.
> 작성일: 2026-05-15

---

## 1. 배경 — 관찰된 문제

스타필드시티 위례 주차장(KA-1935812519) 수동 크롤링 1007건 파이프라인 검증 중 발견:

- AI filter subagent가 **동일 콘텐츠를 청크에 따라 다르게 판정** (raw 518959/519109: 단독 청크 → PASS / 15건 청크 → boilerplate 제거).
- 원인: 현재 Stage 3가 `(raw_id, lot_id)` 쌍을 입력받아 ① 콘텐츠 품질 ② **lot 정합성(wrong_lot)** ③ lot-specific 요약을 **한 번에** 판단. 세 관심사가 섞이면서 판정이 불안정.

### 사양 불일치 (root cause)

| 문서 | wrong_lot 취급 |
|------|---------------|
| `src/server/crawlers/lib/ai-summary-prompt.ts` (single source of truth) | **미포함** — line 8 "wrong_lot 판정은 매칭 단계에서 자연 처리되므로 미포함", line 33 `removed_by` enum에 wrong_lot 없음 |
| `.claude/agents/pipeline-ai-filter.md` line 51 | wrong_lot을 filter_passed 판정 기준으로 **재도입** |

→ 에이전트 지침이 단일 사양과 어긋나 있음. 정렬 필요.

---

## 2. 결정

1. **AI filter는 wrong_lot 체크 안 함** — lot 토큰이 본문에 없어도 콘텐츠 품질만 보고 통과/제거. wrong_lot → pass 처리.
2. **lot 정합성은 match-dump 책임** — 통과한 깨끗한 주차글 풀에서 최적 lot을 찾는다.
3. match-dump 매칭 정확도는 **eval 후 개선** (별도 Phase).

근거: "필터 없이 정확히 어느 주차장인지 찾기"보다 "주차글 확정 후 가까운 lot 찾기"가 더 정확하게 동작할 가능성이 높다. AI 질문을 1개(콘텐츠 품질)로 단순화하면 판정 일관성↑.

---

## 3. 변경 범위

### Phase 1 — AI filter lot-agnostic 화 (최소 변경)

- **`.claude/agents/pipeline-ai-filter.md`**
  - Step 2 filter 기준에서 `wrong_lot` 항목 제거 (line 51).
  - 출력 스키마 예시 / stats `removal_breakdown`에서 `wrong_lot` 키 제거 (line 98).
  - 한 줄 요약 키 설명에서 `wl=wrong_lot` 제거 (line 128).
  - summary는 여전히 입력된 `lot_name` 기준으로 생성 (lot은 match-dump가 medium-candidates에 넣어준 후보를 그대로 신뢰).
- **`src/server/crawlers/lib/ai-summary-prompt.ts`** — 변경 없음 (이미 wrong_lot 미포함, 사양 정본).
- 동작: medium-candidate의 `(raw, lot)` 쌍에서 lot이 다소 어긋나도 콘텐츠가 양질이면 통과 → match-apply가 해당 lot으로 INSERT. 잘못된 lot 매칭은 Phase 2 match 개선으로 흡수.

### Phase 2 — match-dump eval + 개선 (Phase 1 효과 측정 후)

- eval: Phase 1 적용 후 1007 raw 재실행. 측정 지표:
  - KA-1935812519 매칭 수 (목표: 0 → 의미 있는 수치)
  - 전체 pass rate (정상 10~65%)
  - 잘못된 lot 매칭 비율 (수동 샘플 점검 N=30)
- **매칭 신호 우선순위 (재검토 결과)**:
  - 추천/감성글은 본문에 **lot 이름만** 등장하고 주소가 없을 가능성이 높음. 정보성 블로그만 도로명 주소 보유.
  - → geo/주소 근접을 **주 매칭 수단으로 쓰면 다수 콘텐츠(감성/추천글)에서 작동 안 함**. 위험.
  - **주 신호 = 이름 변형 매칭**: 이미 `lotNameInFullText`에 공백 무시 / 어순 뒤집기 / part 전체 출현 추가 완료. 이 축을 더 정교화하는 게 핵심.
  - **보조 신호 = geo/주소**: 본문에 도로명 주소가 **있을 때만** 동명 lot 간 tiebreaker로 사용. 없으면 이름 매칭으로만 결정. (주 수단 아님)
- 개선 후보 (eval 결과로 우선순위 결정):
  - 이름 변형 매칭 정교화 (오탐 줄이되 변형 흡수 — 약어/별칭/부분명)
  - 동명·유사명 lot **disambiguation** — 이름만으로 후보가 여러 개일 때 우선순위 규칙 (인기/신뢰도/주소 일부 토큰)
  - `isCandidateLocationCompatible` (wrong_lot skip 510건 유발) 완화/정교화
  - FTS 과매칭 오염 제거 (제목 "X 주차장" 패턴이 무관 lot 흡수하는 문제)
  - geo/주소 매칭은 **주소 보유 글 한정 tiebreaker**로만 (선택)

---

## 4. 파이프라인 순서 (검토 결과)

사용자 제안: match-dump를 AI filter **이후**로 이동.

- 이상적 형태:
  ```
  Stage 2: AI filter (lot-agnostic, 콘텐츠 품질만)
  Stage 3: match-dump (확정된 주차글 → 이름 매칭 기반 최적 lot)
  Stage 4: AI summary (lot 확정 후 lot-specific 요약)
  ```
- match-dump는 **이름 변형 매칭이 주 수단**이라는 전제 유지 (주소·geo는 보유 글 한정 tiebreaker). 콘텐츠 품질이 확정된 풀에서 이름 매칭하므로 노이즈↓.
- 트레이드오프: 요약이 lot-specific이라 매칭 후로 분리 필수 → 2026-05-13 filter+summary 통합을 다시 쪼개고 **AI 패스 2회** (비용↑, 일관성↑).
- ~~**이번 범위 결정**: 전면 재배치는 보류~~ → **확정됨 (아래 §4.1)**.

---

## 4.1 최종 결정 — 파이프라인 재배치 확정 (2026-05-15)

Phase 2 eval(fixture KA-1935812519) 결과를 보고 전면 재배치를 **확정**한다.

**근거:** match-dump를 ai-filter 앞에 두면 (raw,lot) 쌍 단위 평가로 청크별 판정 불안정 + FTS 과매칭 오염이 ai-filter로 전파. ai-filter를 먼저 돌려 콘텐츠 품질을 확정한 풀에서 lot-match하면 노이즈↓·일관성↑ (eval에서 match recall 0.00→0.77, rule high 엄격화로 non-parking 18→1 확인).

### 확정 스테이지 순서

```
0. fulltext-fetch  — pending raw URL → full_text
1. rule filter     — high/medium/low 3분류. low 즉시 폐기
2. ai-filter       — rule 통과(high+medium) raw 대상. 콘텐츠 품질 판정
                     + lot-agnostic summary 1패스 생성 (lot 미확정)
3. lot-match       — ai-filter 통과 글에 최적 lot 매칭
                     (개선된 searchCandidateLots/locComp/lotNameInFullText)
4. data-apply      — bulk SQL 적용 (local 먼저, remote는 fixture eval 통과 후)
```

### 확정 결정 사항

1. **high tier도 ai-filter 경유** — rule high 엄격화(concrete distinct≥2)에도 불구하고, summary를 ai-filter에서 생성해야 하므로 high/medium 모두 Stage 2 통과. rule high 엄격화 효과는 일부 상쇄 인정. (filter_tier 데이터는 우선순위/스코어 신호로 보존.)
2. **summary는 lot-agnostic 1패스** — Stage 2에서 lot 없이 주차 내용 중심 요약 1회 생성. AI 2패스 비용 회피. `src/server/crawlers/lib/ai-summary-prompt.ts` 사양을 lot-무관하게 조정 필요 (lot_name 의존 제거).
3. **Stage 4 적용 범위** — 구조 구현 + local 적용까지. remote는 fixture eval 통과 확인 후 별도 승인.

### 구현 영향 (run-pipeline-149.ts)

- 현 `runMatchDumpStage`(match-dump가 ai 앞)를 분해: rule-passed raw → ai-filter 입력(lot 없음)으로 변경.
- 신규 `lot-match` 스테이지: ai-filter 통과 raw에 searchCandidateLots→locComp→lotNameInFullText→getMatchConfidence로 best lot 선정, 매칭 SQL emit.
- `medium-candidates.json` 스키마에서 lot_id/lot_name/lot_address 제거 (ai-filter는 lot 모름).
- `ai-summary-prompt.ts` lot-agnostic 화.

---

## 5. Eval Fixture — 스타필드시티 위례 (KA-1935812519)

이 lot의 수동 크롤링 데이터를 **match-dump 개선의 고정 회귀 fixture**로 사용한다.

- **데이터**: `data/eval-fixture-KA-1935812519.sql` (1007 web_sources_raw INSERT, naver_blog 500 + naver_cafe 500 + ddg 20, 중복 제거 후 1007).
- **생성 재현**: `bun run scripts/manual-crawl-lot.ts --lot-id KA-1935812519 --remote --display 500` → SQL을 fixture로 영속화.
- **fixture로 적합한 이유** (개선 신호가 다 들어있음):
  - **이름 변형 문제**: `스타필드시티 위례`(259) / `스타필드시티위례`(255, 공백X) / `위례스타필드`(232, 어순) — 변형 매칭 정교화 검증에 최적.
  - **FTS 과매칭 오염**: 검색 결과에 무관 lot 글(쪽샘지구·해운대온천센터·수지구청 등)이 섞여 "X 주차장" 패턴으로 자기 lot에 흡수 — 오염 제거 검증.
  - **boilerplate/광고**: 주만사 앱 홍보글(인근 아마노 lot 추천) — 콘텐츠 품질 판정 + lot 정합성 분리 검증.
  - **빈약한 정답**: 정작 이 lot 직접 리뷰는 거의 없음 — 라이프스타일 글(CGV/맛집)에서 주차 한 줄 언급 처리 검증.

### Eval 지표 (매 iteration 측정)

| 지표 | 측정 방법 | 목표 |
|------|----------|------|
| KA-1935812519 매칭 수 | `web_sources WHERE parking_lot_id='KA-1935812519'` | 0 → 의미 있는 수치 (수동 ground-truth 대비) |
| 전체 pass rate | match-apply stats | 10~65% |
| 잘못된 lot 매칭률 | 매칭 결과 N=30 수동 샘플 점검 | 정량 baseline 설정 후 하락 추세 |
| 변형 이름 누락 | `스타필드시티위례`/`위례스타필드` 보유 raw 중 미매칭 비율 | iteration마다 감소 |

### Eval 루프 (재현 절차)

```bash
# 1) fixture 적재 (local)
bunx wrangler d1 execute parking-db --local --file=data/eval-fixture-KA-1935812519.sql

# 2) state 리셋 (rule filter 결과는 유지, 매칭만 초기화)
bunx wrangler d1 execute parking-db --local --file=/tmp/reset-match-state.sql

# 3) 파이프라인 재실행 (local 전용)
#    match-dump(--all-to-ai) → pipeline-ai-filter subagent → match-apply

# 4) 위 Eval 지표 측정 → 개선 → 2)부터 반복
```

> remote 절대 미반영. fixture eval은 local D1 한정 회귀 테스트.

### rule-filter low 컷 회귀 케이스

`data/fixture-rule-low-fn.json` — rule_low 80건 샘플 AI 판정 결과 중 **false negative 10건**
(rule이 low로 버렸으나 실제 KA 주차 콘텐츠. 추정 FN율 12.5% → 789건 중 ≈99건).
rule-filter `low` 컷 개선 시 이 raw_id 목록을 회귀 케이스로 사용 (개선 후 high/medium 승격 확인).

---

## 6. 작업 순서

1. **Phase 1 구현** — `pipeline-ai-filter.md` 3곳 수정 (wrong_lot 제거).
2. **재실행** — fixture state 리셋 → match-dump(`--all-to-ai`) → AI filter(4청크) → match-apply, local만 적용.
3. **eval** — §5 지표 측정 (KA-1935812519 매칭 수 + pass rate + 잘못된 lot 샘플).
4. **Phase 2 판단** — eval 결과로 match-dump 개선 항목/순서 재배치 여부 결정.
5. **반복** — match-dump 개선 → §5 Eval 루프로 회귀 측정.

---

## 7. 리스크

| 리스크 | 영향 | 완화 |
|--------|------|------|
| wrong_lot 미체크 → 엉뚱한 lot에 양질 글 INSERT | 잘못된 매칭 데이터 | Phase 2 match 정확도 개선으로 흡수. Phase 1은 local만 적용, remote 미반영. |
| AI 패스 단순화로도 일관성 안 잡힘 | 재현성 낮음 | chunk size 축소 / 판정 기준 명문화 별도 검토 |
| match-dump 개선 전까지 데이터 품질 저하 | 운영 DB 오염 | remote 적용은 Phase 2 eval 통과 후에만 |

---

## 8. 적용/롤백

- 모든 검증은 **local D1만**. remote는 Phase 2 eval 통과 후 일괄 적용.
- 롤백: `pipeline-ai-filter.md`는 git 추적 — revert 가능. DB는 local 한정이라 영향 없음.
