# 주차장 AI 요약 생성 계획 (web_sources.ai_summary 기반)

**작성일**: 2026-04-27  
**상태**: 계획 확정

---

## 목표

`parking_lot_stats.ai_summary / ai_tip_*` 필드를 채워 상세 페이지(wiki/$slug.tsx)에 AI 요약을 표시한다.

---

## 현황

| 항목 | 수치 |
|------|------|
| web_sources 총계 | 21,885건 |
| web_sources.ai_summary 완료 | 21,788건 (~99.6%) |
| **모든 소스 채워진 주차장 (즉시 실행 가능)** | **8,722개** |
| parking_lot_stats.ai_summary 완료 | 0개 |
| UI (`src/routes/wiki/$slug.tsx:326~376`) | ✅ 이미 구현됨 |

---

## 기존 방식 vs 변경 방식

| 구분 | 기존 (`generate-lot-summary.ts`) | 변경 |
|------|----------------------------------|------|
| AI 호출 | `import Anthropic` + `ANTHROPIC_API_KEY` | `claude -p` CLI 서브에이전트 |
| 입력 소스 | `web_sources.title + content` (원문) | `web_sources.ai_summary` (이미 요약된 1줄) |
| 배치 조건 | `web_sources COUNT(*) >= 3` | **모든** web_sources에 ai_summary 채워진 lots |
| 인증 | API 키 필요 | Claude Code 기존 세션 OAuth 재사용 |

---

## 구현 내용

### 1. `fetchSources()` 쿼리 변경

```sql
-- 변경 후: ai_summary만 SELECT, NULL/빈값 제외
SELECT ai_summary AS summary_text
FROM web_sources
WHERE parking_lot_id = '{id}'
  AND ai_summary IS NOT NULL
  AND ai_summary != ''
ORDER BY relevance_score DESC
LIMIT 30
```

### 2. `resolveLots()` 배치 조건 변경

```sql
-- 변경 후: 모든 web_sources에 ai_summary가 채워진 주차장만
WHERE (s.ai_summary IS NULL OR s.ai_summary = '')
  AND EXISTS (
    SELECT 1 FROM web_sources w
    WHERE w.parking_lot_id = p.id
      AND w.ai_summary IS NOT NULL AND w.ai_summary != ''
  )
  AND NOT EXISTS (
    SELECT 1 FROM web_sources w
    WHERE w.parking_lot_id = p.id
      AND (w.ai_summary IS NULL OR w.ai_summary = '')
  )
```

### 3. Claude CLI 서브에이전트 호출 방식

`import Anthropic` + `ANTHROPIC_API_KEY` 제거 → `claude -p` 서브프로세스로 교체.

```typescript
async function callClaude(userPrompt: string): Promise<AiSummaryResult> {
  const proc = Bun.spawn(
    ["claude", "-p", userPrompt,
     "--system-prompt", SYSTEM_PROMPT,
     "--model", "claude-haiku-4-5-20251001",
     "--output-format", "text",
     "--dangerously-skip-permissions"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const text = (await new Response(proc.stdout).text()).trim();
  const jsonText = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  return JSON.parse(jsonText) as AiSummaryResult;
}
```

**핵심 플래그:**
- `--output-format text`: 텍스트 출력 (JSON 직접 파싱)
- `--model claude-haiku-4-5-20251001`: 비용 절감
- `--dangerously-skip-permissions`: 배치 실행 시 허가 프롬프트 없음
- `Bun.spawn` 배열 형식: 시스템 프롬프트 내 따옴표/개행 escape 문제 방지
- `--bare` 사용 금지: bare 모드는 OAuth 미지원, ANTHROPIC_API_KEY 필수

### 4. `buildUserPrompt()` 포맷 변경

```
대상 주차장:
- 이름: {name}
- 주소: {address}

블로그·커뮤니티 요약 (N건):
- {summary_text_1}
- {summary_text_2}
...

사용자 리뷰 (최근 N건):
[R1] 종합 4/5 · 진입 4 · ... — "코멘트"
```

### 5. JSON 스키마 (--json-schema용)

```json
{
  "type": "object",
  "properties": {
    "summary":         { "type": "string" },
    "tip_pricing":     { "type": ["string", "null"] },
    "tip_visit":       { "type": ["string", "null"] },
    "tip_alternative": { "type": ["string", "null"] }
  },
  "required": ["summary", "tip_pricing", "tip_visit", "tip_alternative"]
}
```

---

## 실행 순서

```bash
# 1. dry-run: 프롬프트 길이/내용 확인 (claude 호출 없음)
bun run scripts/generate-lot-summary.ts --batch --limit=5 --dry-run --remote

# 2. 소규모 검증: 결과 품질 육안 확인
bun run scripts/generate-lot-summary.ts --batch --limit=10 --remote

# 3. 전체 실행 (8,722개, 시간 소요)
bun run scripts/generate-lot-summary.ts --batch --limit=9000 --remote
```

---

## 리스크

| 수준 | 항목 | 대응 |
|------|------|------|
| LOW | ai_summary 없는 web_sources 주차장 누락 | 조건에서 자동 제외, 나중에 재실행 |
| LOW | `ON CONFLICT DO UPDATE`라 재실행 안전 | 없음 |
| LOW | `--bare` 모드에서 Claude Code OAuth 세션 필요 | 로컬 실행 환경에서만 가능 |
| INFO | 8,722개 × Haiku 비용 ≈ $2~3 | `--max-budget-usd`로 개별 상한 |

---

## 완료 기준

- `parking_lot_stats.ai_summary` 채워진 주차장 8,722개
- `/wiki/{slug}` 상세 페이지에서 AI 요약 카드 렌더링 확인
