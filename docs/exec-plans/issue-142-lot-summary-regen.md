# 구현 계획: lot summary 재생성 + SSR 검증 (#142 — Phase E)

> Parent: #138 — Phase E
> Milestone: M9 콘텐츠 보강을 위한 크롤링 파이프라인 개선
> Depends on: #141 (web_sources ai_summary 재생성 완료)

## 목적

#141에서 보강한 `web_sources.ai_summary`를 입력으로 `parking_lot_stats.ai_summary` 및 ai_tip 필드를 재생성. wiki SSR 어절 수 / Siteliner 메트릭으로 콘텐츠 개선을 검증한 뒤 M9 파이프라인 회고를 정리.

## 현재 상태 (2026-05-06 기준)

| 항목 | 값 |
|------|----|
| `web_sources.ai_summary` 비어있지 않은 건수 | 15,476건 (avg 32자, max 199자) |
| `parking_lot_stats.ai_summary` empty/null | 28,098건 |
| `parking_lot_stats.ai_summary` non-empty (구형) | 3,841건 (avg 37자, #141 이전 snippet 기반 생성) |
| 재생성 대상 (web_source 보유 lot 전체) | ~3,548 ~ 7,000개 (기존 ai_summary 유무 무관) |

**전체 재요약 방침**: `parking_lot_stats.ai_summary` 기존 값과 무관하게, web_sources.ai_summary를 보유한 lot을 모두 재생성한다. web_sources 임계값 없음.

## 전체 흐름

```
Remote D1 export
    ↓
Local SQLite (wrangler state 갱신)
    ↓
Step 2: extract-lots-for-agent.ts (로컬, --remote 없음)
    ↓  data/lots_for_lot_summary.json
    │  [{id, name, address, web_summaries[], reviews[]}]
    │  - web_summaries: 해당 lot의 web_sources.ai_summary 전체 (상위 30건)
    │  - reviews: user_reviews 최근 30건 텍스트
    │  - 순서: final_score DESC (SEO 효과 높은 lot 우선)
    ↓
Step 3: build-lot-summary-chunks.ts (신규, 로컬 실행)
    ↓  /tmp/lot-summary-chunks/chunk-NNNN.txt (10 lots/청크)
    │  총 ~350개 청크 (3,500 lots / 10)
    ↓
Step 4: Eval — 첫 1개 청크(10 lots) Haiku subagent 실행
    ↓  결과 검토 → 사용자 보고 → 승인
    ↓
Step 5: 전체 배치 — 병렬 Haiku subagents (orchestrator 청크별 spawn)
    ↓  각 subagent: chunk-NNNN.txt 읽기 → JSON 출력
    │  [{id, summary, tip_pricing, tip_visit, tip_alternative}]
    ↓
Step 5b: 결과 집계 → data/lot-summary-regen.sql (UPSERT 문 묶음)
    ↓
Step 6: Remote apply
    │  bunx wrangler d1 execute parking-db --remote --file data/lot-summary-regen.sql
    ↓
Step 7: SSR 검증 — verify-wiki-seo.ts → data/issue-142-ssr-metrics.json
    ↓
Step 8: Siteliner (수동)
    ↓
Step 9: 회고 문서
```

## 구현 단계

### Step 1: Remote → Local 동기화

```bash
# remote 전체 export
bunx wrangler d1 export parking-db --remote --output /tmp/remote-parking-dump.sql

# local wrangler state에 적용
bunx wrangler d1 execute parking-db --local --file /tmp/remote-parking-dump.sql

# spot-check
bunx wrangler d1 execute parking-db --local \
  --command "SELECT COUNT(*) FROM parking_lots"
```

이후 모든 추출 스크립트는 `--remote` 없이 실행 — d1.ts `getLocalDb()`가 `.wrangler/state/v3/d1/*.sqlite`를 직접 읽는다.

---

### Step 2: 대상 추출 (`extract-lots-for-agent.ts`)

#### 현재 `pickDefault()` 추출 기준 (변경 전)

```sql
WHERE (s.ai_summary IS NULL OR s.ai_summary = '')   -- ← 기존 값 없는 lot만
  AND EXISTS (
    SELECT 1 FROM web_sources w
    WHERE w.parking_lot_id = p.id
      AND w.ai_summary IS NOT NULL AND w.ai_summary != ''
  )
ORDER BY COALESCE(s.final_score, 0) DESC
```

문제: 이미 ai_summary가 있는 3,841건이 추출 대상에서 빠짐.

#### 변경 후

```sql
-- parking_lot_stats.ai_summary 기존 값 조건 제거
WHERE EXISTS (
  SELECT 1 FROM web_sources w
  WHERE w.parking_lot_id = p.id
    AND w.ai_summary IS NOT NULL AND w.ai_summary != ''
)
ORDER BY COALESCE(s.final_score, 0) DESC
```

기존 값 유무에 관계없이, **web_sources.ai_summary가 하나라도 있는 lot 전체**가 대상.

#### 실행

```bash
bun run scripts/extract-lots-for-agent.ts \
  --limit=99999 \
  --output=data/lots_for_lot_summary.json
```

#### 출력 스키마

```jsonc
[
  {
    "id": "KA-1234567890",
    "name": "홍대 공영주차장",
    "address": "서울특별시 마포구 ...",
    "web_summaries": [
      "기본 30분 1,000원, 이후 10분당 500원이며 1일 최대 10,000원입니다...",
      "주말 오후 2시면 만차가 될 정도로 혼잡합니다...",
      // 상위 30건 (relevance_score DESC)
    ],
    "reviews": [
      "[R1] 종합 4/5 · 진입 3 · 주차면 4 · 통로 3 · 출차 4 — \"진입로 좁지만 주차면은 넓음\"",
      // 최근 30건
    ]
  }
]
```

#### web_summaries가 0건인 lot 처리

reviews만 있는 lot도 추출 대상에 포함. 청크 빌더에서 web_summaries 0건이면 "(블로그·커뮤니티 언급 없음)" 표기. 두 소스 모두 0건이면 청크에서 skip (→ `data/lot-summary-skipped.json`에 기록).

---

### Step 3: 청크 프롬프트 빌더 (`scripts/build-lot-summary-chunks.ts`)

#### 역할

JSON 배열을 10 lots 단위 청크로 분할하고, Haiku subagent가 바로 읽을 수 있는 프롬프트 파일을 생성한다.

#### 입·출력

- 입력: `data/lots_for_lot_summary.json`
- 출력: `/tmp/lot-summary-chunks/chunk-NNNN.txt` (~350개)
- 각 파일: system prompt + 10 lots 데이터

#### 청크 크기 결정 근거

| 기준 | 값 |
|------|----|
| lots/청크 | 10 |
| 청크당 예상 입력 토큰 | ~3,000 (system ~800 + 10 lots × 약 220) |
| 청크당 예상 출력 토큰 | ~500 |
| 총 청크 수 (3,500 lots) | ~350 |
| 예상 비용 (Haiku) | ~$2.5 |

#### 프롬프트 구조

```
[SYSTEM]
당신은 주차장 정보 큐레이터입니다. 입력된 주차장별 블로그 요약과 사용자 리뷰를 분석해
아래 JSON 배열만 출력하세요. 다른 텍스트는 절대 금지입니다.

출력 형식:
[
  {
    "id": "KA-...",
    "summary": "주차장 전체 특징 2~3문장 (120~180자). 진입 난이도·주차면·요금·혼잡 위주.",
    "tip_pricing": "요금 구조·할인·무료 여부. 근거 없으면 null.",
    "tip_visit": "진입 경로·혼잡 시간대·주의사항. 근거 없으면 null.",
    "tip_alternative": "근처 대안 주차장·대중교통 연계. 근거 없으면 null."
  }
]

공통 규칙:
- 경어체(~습니다/~합니다/~입니다)만 사용
- 메타 표현("AI가 분석" 등) 금지, 이모지·마크다운 금지
- 근거 없는 필드는 null
- 입력 데이터에 없는 수치·사실 출력 금지 (할루시네이션 금지)
- 데이터 부족으로 summary 생성 불가한 경우 summary를 ""(빈 문자열)로

[USER]
### [KA-1234567890] 홍대 공영주차장 (서울특별시 마포구 ...)
블로그 요약 3건:
- 기본 30분 1,000원, 이후 10분당 500원이며 1일 최대 10,000원입니다...
- 주말 오후 2시면 만차가 될 정도로 혼잡합니다...
- 진입로가 좁아 대형차 진입이 어렵습니다...
사용자 리뷰 2건:
- [R1] 종합 4/5 · 진입 3 · 주차면 4 · 통로 3 · 출차 4 — "진입로 좁지만 주차면은 넓음"
- [R2] 종합 3/5 · ...
---
### [KA-0987654321] ...
```

#### Haiku subagent 호출 방식

#141 패턴 동일 — orchestrator(Claude)가 청크별로 Haiku subagent를 병렬 spawn:

```
Agent(subagent_type="general-purpose", model="haiku", prompt="""
다음 파일을 읽어 주차장 요약을 생성하세요.

1. Read /tmp/lot-summary-chunks/chunk-0001.txt
2. system prompt 지시대로 JSON 배열 출력
3. 결과를 /tmp/lot-summary-results/result-0001.json 에 저장
""")
```

- 병렬 처리: 10개 청크씩 동시 실행
- 각 subagent 완료 후 다음 10개 spawn
- 실패한 청크 번호는 별도 리스트로 기록 → 재실행

---

### Step 4: Eval 체크포인트 (사용자 보고 필요)

첫 1개 청크(10 lots)만 Haiku subagent 실행 → 결과 검토.

보고 내용:
- 10건 전체 출력 (name, summary, tip_pricing)
- 평균 summary 길이
- empty summary 건수
- 품질 이슈 여부 (hallucination, 패딩, 경어체 오류)

**사용자 승인 후** 전체 배치 진행.

Eval 실패 기준 (재조정 요청):
- empty summary > 30%
- avg summary 길이 < 40자
- 명백한 hallucination 또는 규칙 위반 다수 발견

---

### Step 5: 전체 배치

```bash
# 전체 청크 빌드 (~350개)
bun run scripts/build-lot-summary-chunks.ts \
  --input=data/lots_for_lot_summary.json \
  --chunk-size=10 \
  --output-dir=/tmp/lot-summary-chunks
```

orchestrator가 10개씩 병렬 Haiku subagent spawn → `/tmp/lot-summary-results/result-NNNN.json` 생성.

#### Step 5b: 결과 집계 → SQL emit

모든 result JSON 파일을 읽어 UPSERT SQL 생성:

```sql
-- data/lot-summary-regen.sql (수천 행)
INSERT INTO parking_lot_stats
  (parking_lot_id, ai_summary, ai_tip_pricing, ai_tip_visit, ai_tip_alternative,
   ai_summary_updated_at, ai_tip_updated_at)
VALUES
  ('KA-...', '홍대 공영주차장은 기본 30분 1,000원...', '기본 30분 1,000원...', '주말 오후 2시 이후 만차...', NULL,
   datetime('now'), datetime('now'))
ON CONFLICT(parking_lot_id) DO UPDATE SET
  ai_summary           = excluded.ai_summary,
  ai_tip_pricing       = excluded.ai_tip_pricing,
  ai_tip_visit         = excluded.ai_tip_visit,
  ai_tip_alternative   = excluded.ai_tip_alternative,
  ai_summary_updated_at = excluded.ai_summary_updated_at,
  ai_tip_updated_at    = excluded.ai_tip_updated_at;
```

empty summary(`""`)인 row는 SQL에서 제외 (기존 값 유지).

---

### Step 6: Remote Apply

```bash
bunx wrangler d1 execute parking-db --remote --file data/lot-summary-regen.sql
```

apply 후 spot-check:

```bash
bunx wrangler d1 execute parking-db --remote \
  --command "SELECT COUNT(*), AVG(LENGTH(ai_summary)) FROM parking_lot_stats WHERE ai_summary_updated_at > date('now', '-1 day')"
```

---

### Step 7: SSR 검증 (`scripts/verify-wiki-seo.ts`)

- 대상: `ai_summary_updated_at` 신규 + `final_score` 상위 100 lots의 wiki slug
- 동작: `https://<prod>/wiki/<slug>` fetch → `<script>/<style>` strip → 공백 기준 어절 수
- concurrency 5, 200ms throttle (서버 부하 방지)
- 출력: `data/issue-142-ssr-metrics.json`

```json
{
  "measured_at": "2026-05-06T...",
  "sample_size": 100,
  "avg": 850,
  "p25": 620,
  "p50": 830,
  "p75": 1100,
  "min": 210,
  "max": 2400,
  "pages": [
    { "slug": "...", "word_count": 920 }
  ]
}
```

목표: **p50 ≥ 800 어절**

---

### Step 8: Siteliner (수동)

- siteliner.com → 사이트 루트 측정
- 캡처: 평균 page size, 중복 콘텐츠 %
- 목표: page size ≥ 50KB, 중복 < 15%
- 결과를 회고 문서에 기록 (PR 머지 차단 없음)

---

### Step 9: 회고 문서

`docs/exec-plans/issue-138-pipeline-improvement.md`에 Phase E 섹션 추가:

- 처리 건수 (eligible → 생성 성공 → empty skip)
- SSR p25/p50 어절 수 vs `data/issue-138-audit.md` baseline
- Siteliner 결과 캡처
- 비용 실측 (Haiku 토큰)
- 이슈 원문(`>= 200자, >= 3개`) 대비 실제 운영 기준 차이 기록

## 수정 파일 요약

| 파일 | 변경 |
|------|------|
| `scripts/extract-lots-for-agent.ts` | `pickDefault()` WHERE 조건 수정 — ai_summary 기존 값 조건 제거 (전체 재요약) |
| `scripts/build-lot-summary-chunks.ts` | **신규**: JSON → 청크 프롬프트 파일 빌더 (10 lots/청크) |
| `scripts/verify-wiki-seo.ts` | **신규**: wiki SSR 어절 수 측정 |
| `docs/exec-plans/issue-138-pipeline-improvement.md` | Phase E 회고 섹션 추가 |

> `generate-lot-summary.ts`는 수정하지 않음. 단발 모드(`--lotId=`, `--keyword=`)는 기존 유지.

## 완료 기준

- [ ] `parking_lot_stats.ai_summary` 신규 생성: eligible lots의 ≥ 80% non-empty
- [ ] Eval 체크포인트 통과 (empty ≤ 30%, avg ≥ 40자)
- [ ] D1 쓰기: SQL chunk emit + `--file` apply (per-row wrangler 0회)
- [ ] `data/issue-142-ssr-metrics.json` 생성
- [ ] 회고 문서 Phase E 섹션 작성 완료
- [ ] PR 머지

## 리스크

| 리스크 | 완화 |
|--------|------|
| Haiku JSON 파싱 실패 | 실패 청크 번호 기록 → 재실행 |
| web_sources avg 32자 ceiling → lot summary 빈약 가능 | Eval 단계에서 확인 후 판단 |
| Local DB 동기화 불완전 | Step 1 직후 `SELECT COUNT(*)` spot-check |
| Siteliner 수동 측정 지연 | PR 머지 차단 없이 비동기 진행 |
