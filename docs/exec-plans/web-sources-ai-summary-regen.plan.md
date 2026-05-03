# web_sources.ai_summary 재생성 실행 계획 (v2: top-N + lot-specific long-form)

**작성일**: 2026-04-29 (v1) → 2026-05-03 (v2 개정) → 2026-05-03 (v3 결론)
**관련 이슈**: #135 (SEO P1)
**상태**: **scope 축소 완료** — 데이터 가드 작업으로 마무리, long-form 효과는 후속 이슈로 이전

---

## 🔚 v3 결론 (2026-05-03 파일럿 후)

**데이터 한계로 인해 이슈 #135의 원래 가정이 성립 불가능함을 확인.**

### 파일럿 실측 결과

| 단계 | 결과 |
|------|------|
| extract (lot 10개, top-N 5, all sources) | 45 row |
| agent (long-form 요청) | 10 row만 처리 (lot당 1개로 자체 축소) |
| c안 정책 적용 | 3 row 통과 (수율 6.7%) |
| **재시도 (tistory_blog 화이트리스트)** | **27 row 모두 빈 문자열 — agent가 보일러플레이트로 reject** |

### 발견된 데이터 진실

| source | 개수 | 실제 가치 |
|--------|------|----------|
| ddg_search | 9,382 | 매체/보도자료/플랫폼 자동페이지 |
| naver_blog | 9,386 | snippet only (avg 121자, 풀텍스트 0건) |
| naver_cafe | 3,014 | snippet only (avg 122자, 풀텍스트 0건) |
| tistory_blog | 600 | **SEO 자동생성 보일러플레이트 (~99%)** ⚠️ |
| naver_place | 13 | 소량 |

→ **SEO 가치 있는 풀텍스트 web_sources ≈ 0**.

### 후속 이슈 권장 (분리 발행)

- **이슈 X (선결)**: `naver_blog`/`naver_cafe` source_url 12,400개 풀텍스트 재크롤 — rate limit/차단 회피 필요 (1~2일)
- **이슈 Y (즉시 가능)**: `parking_lot_stats.ai_summary` 강화 (`scripts/generate-lot-summary.ts`) — 외부 source 의존 없이 메타데이터 + user_reviews + stats 통합 합성으로 SEO 단어수 향상
- **이슈 Z (장기)**: user_review 적극 수집 — 진짜 lot-specific 정보 source

### 이번 작업에서 살아남은 가치 (commit 대상)

신규 데이터 들어왔을 때 가드 역할:
- `ai-filter.ts` — short_summary 자동 reject (raw 단계 가드), MIN_SUMMARY_LENGTH=200, max_tokens 1200
- `ai-filter.test.ts` — 12 단위 테스트
- `extract-top-sources-by-lot.ts` — quality_score, source 화이트리스트, dup-penalty 합리화
- `apply-summaries.ts` — c안 정책 (new > old AND new ≥ 200)
- `agent.md` — 보일러플레이트/보도자료 reject 강화
- 문서 갱신 (이 plan + reference)

이슈 X/Y로 풀텍스트 또는 합성 콘텐츠가 들어오면 위 가드가 즉시 활용됨.

---

## (이하 v2 원안 — 참고용 보존)

---

## 배경

**v1 계획(2026-04-29)**: 저품질 ai_summary 6,591건을 "30~60자 한줄" 프롬프트로 재생성.

**개정 사유 (2026-05-03)**:
- 이슈 #135 진단 결과 wiki 페이지 SSR 평균 단어수 315 (median 859 미달).
- 한줄 요약은 SSR 텍스트 풍부도에 기여 못함 → 색인/순위 회복 불가.
- 모든 web_sources를 long-form 시도하면 content 짧은 row(DDG/Brave snippet 등)에서 환각·실패.

**v2 핵심 전략**: **lot당 후보군 선별 + lot-specific long-form**.

> long-form 성패의 70%는 후보군 품질에 달려 있다. 프롬프트 개선만으로는 부족.

---

## 목표

1. SSR 노출되는 wiki 페이지 본문 단어수 ≥ 800 (median 도달)
2. Siteliner 평균 page size 28KB → 50KB+
3. 중복 콘텐츠 비율 ≤ 15% (현재 26%)
4. 비용 ≤ $30 (전체 lot 처리 기준)

---

## 데이터 모델 사실 확인

| 사실 | 출처 | 영향 |
|------|------|------|
| `web_sources.filter_passed` 삭제됨 (0029) | migrations/0029_drop_is_ad.sql | web_sources에는 통과분만 존재 → regen 경로는 filter_passed 무관 |
| `web_sources_raw.filter_passed`는 살아있음 | migrations/0027 | 신규 크롤 short_summary 후처리는 raw에서 작동 |
| `ai_summary_updated_at` 컬럼 존재 | migrations/0034 | 재생성 시각 기록 가능, 별도 컬럼 추가 불필요 |
| `relevance_score` 0~100 integer | schema.ts | quality_score 입력 시그널 |
| `matched_lot_count` 컬럼 없음 | — | `COUNT(DISTINCT parking_lot_id) BY source_url`로 계산 |

---

## 아키텍처

```
[1] 후보군 추출 (scripts/extract-top-sources-by-lot.ts)
    └─ web_sources를 lot별 그룹화
       └─ quality_score 계산 (LENGTH, relevance, source, keywords, dup penalty)
          └─ 그리디 선택 (source 다양성 보장) → lot당 top-N
             └─ data/top-sources-by-lot.json

[2] long-form 생성 (/regen-web-summary slash command)
    └─ ai-summary-generator agent (Haiku, 200~600자, lot-specific)
       └─ data/top-sources-by-lot.sql (UPDATE 문)

[3] c안 정책 적용 (scripts/apply-summaries.ts)
    └─ DB의 기존 ai_summary와 길이 비교
       └─ new > old일 때만 UPDATE
          └─ 짧으면 data/regen-rejected.json에 dump

[4] D1 적용
    └─ wrangler d1 execute --remote --file
```

---

## 후보군 quality_score 설계

### 시그널 가중치 (0.0~1.0 정규화 후 합산)

| 시그널 | 정규화 | 가중치 |
|--------|--------|--------|
| `LENGTH(content)` | min(content_len/1000, 1.0) | 0.30 |
| `relevance_score` | relevance_score/100 | 0.30 |
| `source` 풀텍스트 여부 | naver_blog/tistory_blog/naver_cafe=1.0, 기타=0.3 | 0.10 |
| `ai_difficulty_keywords` 개수 | min(count/5, 1.0) | 0.10 |
| `sentiment_score` 비중립 | abs(score-3.0)/2.0 | 0.05 |
| **`matched_lot_count` 페널티** | -0.10 × (count-1), cap at -0.50 | (감산) |
| **`LENGTH(content) < 200` 컷** | 후보군 자동 제외 | 하드 필터 |

### 그리디 lot당 top-N 선택 (다양성 보장)

```
candidates = [...lot의 web_sources sorted by quality_score DESC]
selected = []
used_sources = set()

for c in candidates:
  if len(selected) >= N: break
  if c.source in used_sources and len(selected) < N//2: continue  // 절반까지는 다양성 강제
  selected.append(c)
  used_sources.add(c.source)

# 다양성 강제로 채우지 못한 자리는 점수 순으로 채움
```

### 빈약한 lot 처리 (B안: 가용한 만큼)

- web_sources < N인 lot도 가용 건수만큼 처리
- 0개인 lot은 이번 재생성 대상 제외 (별도 이슈로)

---

## 실행 단계

### Phase 1 — 신규 크롤 경로 강화 (✅ 완료)

**파일**: `src/server/crawlers/lib/ai-filter.ts`

- SYSTEM_PROMPT의 summary 지시 200~600자 long-form 변경
- 진입로/주차면/통로/요금/혼잡도 항목 체크리스트 추가
- `max_tokens: 600 → 1200`
- `toResult` 후처리: `summary.length < 200 → filter_passed=false, removed_by='short_summary'`
- `MIN_SUMMARY_LENGTH=200` 상수 export

이 변경은 `web_sources_raw` 단계에 작동. 신규 크롤 시 short_summary는 web_sources로 승격되지 않음.

### Phase 2 — agent 사양 갱신

**파일**: `.claude/agents/ai-summary-generator.md`

- "30~60자" → "200~600자"
- 항목 체크리스트(진입로/주차면/통로/요금/혼잡도) 명시
- lot-specific 강조 (parking_lot_name 활용 강화)
- 좋은/나쁜 예시 long-form으로 교체
- 빈 문자열 기준: content 200자 미만 또는 lot 관련 정보 부재 시

### Phase 3 — 후보군 추출 스크립트

**파일**: `scripts/extract-top-sources-by-lot.ts` (신규)

```bash
bun run scripts/extract-top-sources-by-lot.ts --remote \
  --top-n 5 \
  --limit-lots 10 \
  --min-content 200 \
  --output data/top-sources-by-lot.json
```

플래그:
- `--remote` / `--top-n N` / `--limit-lots M` / `--min-content L` / `--output PATH`
- `--lot-id ID` (특정 lot만)
- `--richness` (lot의 web_sources 개수 많은 순 우선, 기본값)

출력 JSON 형식:
```json
[
  {
    "id": 12345,
    "parking_lot_id": "KA-1935812519",
    "parking_lot_name": "스타필드시티 위례",
    "title": "...",
    "content": "...",
    "review_comments": "...",
    "quality_score": 0.87
  }
]
```

### Phase 4 — agent 호출 (long-form 생성)

`/regen-web-summary data/top-sources-by-lot.json --limit 50`

ai-summary-generator agent가 JSON → SQL 변환.

### Phase 5 — c안 정책 적용 스크립트

**파일**: `scripts/apply-summaries.ts` (신규)

agent가 생성한 SQL을 그대로 적용하지 않고, **기존 ai_summary와 비교** 후 적용:

```bash
bun run scripts/apply-summaries.ts \
  --input data/top-sources-by-lot.sql \
  --remote \
  --rejected data/regen-rejected.json
```

로직:
1. SQL에서 `(id, new_summary)` 추출
2. DB에서 현재 `ai_summary` 조회
3. `new.length > old.length AND new.length >= 200` → UPDATE
4. 그 외 → `data/regen-rejected.json`에 사유 dump (id, old_len, new_len, reason)

### Phase 6 — 파일럿 (lot 10개)

1. `extract-top-sources-by-lot.ts --limit-lots 10 --top-n 5` (web_sources 풍부 순)
2. agent 호출하여 SQL 생성
3. `apply-summaries.ts` 실행
4. 검증:
   - 스타필드시티 위례 (KA-1935812519) ai_summary 5개 ≥ 200자
   - 샘플 wiki 페이지 SSR 단어수 측정
   - `data/regen-rejected.json` 검토 (실패율 < 30% 목표)
5. 실패율 높으면 프롬프트 또는 batch_size 조정 → Phase 1/2 회귀

### Phase 7 — 점진 확대

| 단계 | lot 수 | 처리 row 수 (top-5) | 비용 (Haiku) |
|------|-------|-------------------|-------------|
| 파일럿 | 10 | ~50 | ~$0.05 |
| 1차 확대 | 100 | ~500 | ~$0.50 |
| 2차 확대 | 1,000 | ~5,000 | ~$5 |
| 전체 | 13,000 | ~65,000 | ~$25 |

각 단계 후:
- regen-rejected 비율 확인
- 샘플 5건 수동 검수
- 비용 모니터링

### Phase 8 — 빈약한 lot 후속 처리 (별도 이슈)

web_sources < 3개인 lot의 SSR 단어수 보강 — 별도 이슈로 분리.
- 옵션: parking_lot_stats 통합 요약 강화, 추가 크롤 source, address 기반 generated content

---

## 단위 테스트

**파일**: `src/server/crawlers/lib/ai-filter.test.ts` (신규)

vitest 케이스:
- `toResult({summary: 'a'.repeat(100), filter_passed: true})` → `filterPassed=false, filterRemovedBy='short_summary'`
- `toResult({summary: 'a'.repeat(250), filter_passed: true})` → `filterPassed=true, filterRemovedBy=null`
- `toResult({summary: '', filter_passed: false})` → `filterPassed=false, filterRemovedBy='unknown'`
- `MIN_SUMMARY_LENGTH === 200`
- `parseBatch`/`parseOne` 기본 회귀

---

## Risk & Mitigation

| Risk | 영향 | Mitigation |
|------|------|-----------|
| 후보군 점수 계산 부정확 → 잘못된 top-N | High | 파일럿 단계에서 수동 검수, 가중치 튜닝 |
| Haiku가 200자 long-form 안정 출력 못함 | High | c안 정책으로 자동 reject + 비율 모니터링 후 batch_size↓/Sonnet 검토 |
| 빈약한 lot은 그대로 → 단어수 향상 못함 | Medium | Phase 8 별도 이슈로 분리 |
| 비용 폭주 (max_tokens 2배 + 확대) | Medium | 단계적 limit, 각 단계 비용 게이트 |
| matched_lot_count 계산 누락 → dup-content 페널티 미작동 | Low | 추출 스크립트 SQL에 GROUP BY 명시 |

---

## 파일 변경 목록

| 파일 | 종류 | 상태 |
|------|------|------|
| `src/server/crawlers/lib/ai-filter.ts` | 수정 | ✅ 완료 |
| `src/server/crawlers/lib/ai-filter.test.ts` | 신규 | 대기 |
| `.claude/agents/ai-summary-generator.md` | 수정 | 대기 |
| `.claude/commands/regen-web-summary.md` | 수정 | 대기 |
| `scripts/extract-top-sources-by-lot.ts` | 신규 | 대기 |
| `scripts/apply-summaries.ts` | 신규 | 대기 |
| `docs/references/web-sources-ai-summary.md` | 수정 | 대기 |
| `docs/exec-plans/web-sources-ai-summary-regen.plan.md` | 갱신 (현재 문서) | ✅ 완료 |

---

## 검증 기준 (이슈 #135)

- [ ] 스타필드시티 위례 (KA-1935812519) ai_summary 5개 이상이 200자 이상
- [ ] 샘플 wiki 페이지 SSR 단어수 ≥ 800
- [ ] Siteliner 평균 page size ≥ 50KB
- [ ] regen-rejected 비율 < 30% (파일럿 기준)
- [ ] 단위 테스트 통과 (`bun --bun run test`)
- [ ] 레퍼런스 문서(`docs/references/web-sources-ai-summary.md`) 새 사양과 일치

---

## 비용 추정 (개정)

| 항목 | 수량 | 비용 |
|------|------|------|
| Haiku long-form (top-5 × 13K lot) | ~65K row | ~$25 |
| 검증/재시도 마진 | 10% | ~$3 |
| **합계** | | **~$28** |

모델: `claude-haiku-4-5-20251001`
