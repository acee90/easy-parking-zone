---
name: parking-detail-ai-summary
description: 주차장 상세 페이지의 AI 요약·팁 생성·표시 전략 — 단일 API 호출로 4개 필드 동시 생성, DB 구조, UI 표시까지 다루는 실행 지침서.
origin: local
source_doc: scripts/generate-lot-summary.ts + src/routes/wiki/$slug.tsx
---

# 주차장 AI 요약·팁 생성

## 현재 상태 (2026-04-24)

### DB 필드 (`parking_lot_stats`)

| 필드 | 역할 | 현황 |
|------|------|------|
| `ai_summary` | 주차장 전체 요약 (2~3문장) | 스크립트 있음, UI 표시 ✅ |
| `ai_summary_updated_at` | 생성 시각 | — |
| `ai_tip_pricing` | 요금 팁 | 스크립트 있음, UI 표시 ✅ |
| `ai_tip_visit` | 방문/진입 팁 | 스크립트 있음, UI 표시 ✅ |
| `ai_tip_alternative` | 대안 주차 팁 | 스크립트 있음, UI 표시 ✅ |
| `ai_tip_updated_at` | 팁 생성 시각 | — |

### UI 현황 (`src/routes/wiki/$slug.tsx`)

- `lot.curationReason` → "AI 요약" 섹션 최우선 표시 (큐레이션 99건)
- `lot.aiSummary` → `curationReason` 없을 때 fallback으로 동일 섹션에 표시
- `lot.aiTipPricing / aiTipVisit / aiTipAlternative` → 별도 팁 카드 3개로 표시

### 생성 스크립트 (`scripts/generate-lot-summary.ts`)

```bash
# 단일 주차장
bun run scripts/generate-lot-summary.ts --lotId=KA-1234567890

# 키워드 검색 (LIKE)
bun run scripts/generate-lot-summary.ts --keyword="스타필드 위례" --remote

# 배치 모드 (ai_summary 없고 web_sources 3건 이상)
bun run scripts/generate-lot-summary.ts --batch --limit=100

# 드라이런
bun run scripts/generate-lot-summary.ts --batch --limit=5 --dry-run

# 환경변수 필요
ANTHROPIC_API_KEY=sk-ant-...
```

저장 위치: `parking_lot_stats` (4개 필드 동시 UPSERT)

---

## 아키텍처

### 단일 API 호출 → 4개 필드 동시 생성

```
web_sources (상위 30건) + user_reviews (최근 30건)
  → 시스템 프롬프트 (캐싱) + 유저 프롬프트 (lot 데이터)
  → Claude Haiku → JSON { summary, tip_pricing, tip_visit, tip_alternative }
  → parking_lot_stats UPSERT (4개 필드)
```

### 프롬프트 구조

| 구분 | 내용 | 캐싱 |
|------|------|------|
| 시스템 프롬프트 | 규칙 + JSON 출력 형식 | ✅ `cache_control: ephemeral` |
| 유저 프롬프트 | 주차장명/주소 + 소스 데이터 | ❌ (lot마다 다름) |

배치 실행 시 시스템 프롬프트 캐싱으로 비용 절감.

---

## 프롬프트 규칙

```
출력: JSON { summary, tip_pricing, tip_visit, tip_alternative }
- summary: 전체 특징 2~3문장 (120~180자)
- tip_pricing: 요금 구조·할인·무료 조건 (근거 없으면 null)
- tip_visit: 진입 경로·혼잡 시간대·주의사항 (근거 없으면 null)
- tip_alternative: 근처 대안·대중교통 (근거 없으면 null)

공통:
- 경어체(~습니다, ~합니다)만, 평서체(~다) 금지
- "AI가 분석" 같은 메타 표현 금지
- 모순 → "대체로 ~하지만 ~라는 의견도" 형식
- 근거 빈약 → null
```

---

## 모델 선택

- **Claude Haiku 4.5** (`claude-haiku-4-5-20251001`) — 배치 비용 효율
- max_tokens: 600 (4개 필드 JSON 기준)
- SDK: `@anthropic-ai/sdk` v0.78.0 (설치 완료)

---

## curation_reason vs ai_summary

| 필드 | 테이블 | 작성 방법 | 대상 |
|------|--------|-----------|------|
| `curation_reason` | `parking_lots` | 수동 큐레이션 | 99건 (hell 83 + easy 16) |
| `ai_summary` | `parking_lot_stats` | AI 자동 생성 | web_sources ≥ 3인 모든 주차장 |

UI에서는 `curation_reason` 우선, 없으면 `ai_summary` fallback.

---

## 배치 실행 순서

```bash
# 1. 드라이런으로 대상 확인
bun run scripts/generate-lot-summary.ts --batch --limit=10 --dry-run

# 2. 소량 실제 실행 (결과 검수)
bun run scripts/generate-lot-summary.ts --batch --limit=20

# 3. 대량 배치
bun run scripts/generate-lot-summary.ts --batch --limit=500 --remote
```

---

## 주의사항

1. `curation_reason`과 `ai_summary`는 다른 컬럼 — 큐레이션 편집 시 덮어쓰지 말 것
2. `web_sources + reviews`가 모두 0이면 생성 건너뜀 — 빈 텍스트 저장 금지
3. Claude API JSON 파싱 실패 시 해당 lot 건너뜀 (skipped 카운트)
4. 배치 실행 시 rate limit: Haiku 기준 건당 ~1초 소요 예상
