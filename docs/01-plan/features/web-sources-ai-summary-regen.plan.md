# web_sources.ai_summary 저품질 재생성 실행 계획

**작성일**: 2026-04-29  
**상태**: 실행 대기

---

## 목표

기존 20자 제한 프롬프트로 생성된 저품질 `ai_summary` (~6,591건)를 개선된 프롬프트(30~60자)로 재생성한다.

---

## 현황

| 항목 | 수치 |
|------|------|
| web_sources 총계 | ~21,904건 |
| 저품질 ai_summary | ~6,591건 |
| 저품질 비율 | ~30% |

저품질 패턴: `~정보`, `~안내`, `~확인 가능`, `~이용 가능`, `~기록`, `~소개`, 12자 미만

---

## 실행 단계

### Step 1 — 저품질 추출

```bash
# remote D1에서 저품질 소스 추출 → JSON 저장
npx wrangler d1 execute parking-db --remote --command "
SELECT ws.id, ws.title, ws.content, pl.name as parking_lot_name
FROM web_sources ws
LEFT JOIN parking_lots pl ON ws.parking_lot_id = pl.id
WHERE ws.ai_summary IS NOT NULL AND (
  ws.ai_summary LIKE '%정보'
  OR ws.ai_summary LIKE '%안내'
  OR ws.ai_summary LIKE '%확인 가능'
  OR ws.ai_summary LIKE '%이용 가능'
  OR ws.ai_summary LIKE '%이용 안내'
  OR ws.ai_summary LIKE '%기록'
  OR ws.ai_summary LIKE '%소개'
  OR LENGTH(ws.ai_summary) < 12
)
" --json > data/low_quality_sources.json
```

출력: `data/low_quality_sources.json`

### Step 2 — 샘플 품질 검증 & 프롬프트 개선

`/web-sources-ai-summary data/low_quality_sources.json --limit 50` 호출 (Haiku 서브에이전트가 직접 요약 생성).

출력 `data/low_quality_sources.sql`을 열어 아래 기준으로 검토:

- 30~60자 범위인가
- 구체적 정보(혼잡도, 수치, 팁) 포함인가
- `~정보`, `~안내` 등 금지 패턴이 사라졌는가
- 빈 문자열 비율이 적절한가 (내용 없는 소스는 당연히 빈 문자열)

문제 있으면 `.claude/skills/web-sources-ai-summary/SKILL.md`의 요약 기준 수정 후 재실행.  
OK면 Step 3 진행.

### Step 3 — ai_summary 전체 재생성

`/web-sources-ai-summary data/low_quality_sources.json` 호출 (Haiku 서브에이전트).

출력: `data/low_quality_sources.sql`

### Step 5 — DB 업데이트

```bash
npx wrangler d1 execute parking-db --remote --file data/low_quality_sources.sql
```

### Step 6 — 정리

```bash
rm data/low_quality_sources.json data/low_quality_sources.sql
rm scripts/regen-ai-summary.ts
```

---

## 비용 추정

| 항목 | 수량 | 비용 |
|------|------|------|
| Haiku ai_summary 재생성 | 6,591건 | ~$0.60 |

모델: `claude-haiku-4-5-20251001`

---

## 관련 파일

- `scripts/regen-ai-summary.ts` — Step 2/3 실행 스크립트
- `src/server/crawlers/lib/ai-filter.ts` — 프롬프트 (수정 완료)
- `.claude/skills/web-sources-ai-summary/SKILL.md` — 스킬 정의
