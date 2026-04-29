# web_sources.ai_summary 재추출 스킬

## 배경

`web_sources.ai_summary`는 크롤링 원문(`content`)을 AI 필터링 단계에서 한줄로 압축한 요약입니다.
`parking_lot_stats.ai_summary` (주차장 통합 요약) 생성 시 입력 데이터로 사용됩니다.

**설계 원칙 — incremental update:**
- 주차장별로 web_source가 추가될 때 해당 소스의 ai_summary만 재생성
- 기존 ai_summary 목록 + 신규 → 주차장 통합 요약 점진적 업데이트
- raw content 전체 재읽기 없이 효율적인 업데이트 가능

## 파이프라인 구조

```
[크롤링]
web_sources_raw (URL 단위, 주차장 미매칭)
    ↓ ai-filter-sources.ts
    filter_passed / sentiment / ai_summary (lot-agnostic, parkingName="")

[매칭]
web_sources (parking_lot_id 부여)
    ↓ 매칭 후 별도 실행
    ai_summary 재생성 (parkingName 기반 lot-specific)
```

**주의:** `ai-filter-sources.ts`는 매칭 전에 실행되므로 `parkingName`이 빈 문자열.
lot-specific 요약은 매칭 후 별도 단계에서 처리해야 함.

## ai_summary 품질 이슈 두 가지

### 1. content가 짧은 경우 (< 200자)

DDG/브레이브 검색 snippet, POI 데이터 등 원래부터 짧은 소스.
`source`가 `naver_blog` / `naver_cafe` / `tistory_blog`인 경우 URL 재크롤로 풀텍스트 확보 가능.

```sql
SELECT id, source, source_url, LENGTH(content) as len
FROM web_sources
WHERE LENGTH(content) < 200
  AND source IN ('naver_blog', 'naver_cafe', 'tistory_blog')
ORDER BY len
```

처리: `source_url` 재크롤 → `content` 업데이트 → `ai_summary` 재생성

### 2. 여러 주차장 나열 글 (lot-agnostic 요약)

"남해군 무료주차장 38곳" 같은 글이 38개 주차장에 매칭된 경우,
현재는 모든 lot에 동일한 요약이 복사됨.

매칭 후 `parkingName`을 넘겨서 해당 주차장 관련 내용만 추출해야 함:

```
[현재] web_sources (lot A, B, C) → 동일한 ai_summary
[목표] web_sources (lot A) → "설천면 해변 인근, 무료"
       web_sources (lot B) → "남해읍 중심가, 무료"
```

## 저품질 ai_summary 필터 기준

기존 프롬프트의 20자 제한으로 인한 저품질 패턴 (~6,591건 / 21,904건):

```sql
SELECT id, title, content, ai_summary
FROM web_sources
WHERE ai_summary IS NOT NULL AND (
  ai_summary LIKE '%정보'
  OR ai_summary LIKE '%안내'
  OR ai_summary LIKE '%확인 가능'
  OR ai_summary LIKE '%이용 가능'
  OR ai_summary LIKE '%이용 안내'
  OR ai_summary LIKE '%기록'
  OR ai_summary LIKE '%소개'
  OR LENGTH(ai_summary) < 12
)
```

## 재추출 프롬프트 (ai-filter.ts 적용 완료)

```
- summary: 주차 관련 구체적 한줄 (30~60자). 아래 우선순위:
  1) 개인 경험 기반 혼잡도: "평일 여유, 주말 오후 만차", "점심시간 30분 대기"
  2) 구체적 수치/특이사항: 층수, 요금, 입구 너비, 기둥·경사 여부
  3) 실용적 팁: 진입 경로, 추천/비추천 이유
  주차장 이름이 명시된 경우, 그 주차장에 해당하는 내용만 추출 (여러 주차장 나열 글).
  금지: "~정보", "~안내", "~확인 가능", "~이용 가능" 등 메타 표현.
  주차 관련 구체 정보가 없으면 빈 문자열.
```

## 실행 계획

### Phase 1 — 저품질 재처리 (즉시 가능)

```bash
# 1. 저품질 6,591건 추출
#    → low_quality_sources.json (id, title, content, parking_lot_id, name)

# 2. subagent로 재요약 (parkingName 포함)
#    → regen_summaries.sql

# 3. remote D1 적용
npx wrangler d1 execute parking-db --remote --file regen_summaries.sql

# 4. 임시 파일 제거
```

### Phase 2 — content 짧은 소스 재크롤 (추후)

```bash
# naver_blog/cafe 중 content < 200자인 소스 URL 재크롤
# content 업데이트 후 ai_summary 재생성
```

### Phase 3 — lot-specific 요약 (추후)

```bash
# 매칭된 web_sources에 parkingName 기반으로 ai_summary 재생성
# 특히 여러 주차장 나열 글 (동일 source_url, 여러 parking_lot_id)
```

## 비용 추정

| 항목 | 수량 | 비용 |
|------|------|------|
| Phase 1 ai_summary 재생성 | 6,591건 | ~$0.60 |
| Phase 2 재크롤 | TBD | 크롤링 비용 |
| Phase 3 lot-specific | TBD | ~$1-2 |

모델: `claude-haiku-4-5-20251001`

## 관련 파일

- `src/server/crawlers/lib/ai-filter.ts` — ai_summary 프롬프트 (수정 완료)
- `scripts/ai-filter-sources.ts` — 신규 web_sources 배치 필터링 러너
- `scripts/generate-lot-summary.ts` — 주차장 통합 요약 생성
