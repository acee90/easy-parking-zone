---
description: "[DEPRECATED #149] /run-pipeline filter 로 대체됨"
model: claude-haiku-4-5-20251001
---

> **Deprecated**: #149 fulltext-first 파이프라인으로 교체됨.
> AI 필터는 이제 `runAiFilterBatch` (Cron) 또는 `/run-pipeline filter` 로 실행.
> 이 커맨드는 스니펫 기반 구파이프라인 문서이므로 사용하지 말 것.

# Batch AI Filtering

## 개요
이 스킬은 로컬 DB의 미분류 데이터를 추출하여 AI로 분석하고, 그 결과를 리모트 DB(`--remote`)에 일괄 업데이트하는 워크플로우를 제공합니다.

## 사용 시점
- `web_sources_raw` 테이블에 `ai_filtered_at`이 NULL인 데이터가 대량으로 쌓여있을 때.
- 로컬에서 데이터를 먼저 검토하고 리모트 DB에 한 번에 반영하고 싶을 때.

## 워크플로우

### 1. 데이터 추출 (Local -> JSON)
로컬 DB에서 미분류된 데이터를 `batch_to_filter.json`으로 1,000건 추출합니다.
```bash
# scripts/export-batch-for-gemini.ts 내의 BATCH_LIMIT을 1000으로 수정하거나 수동 실행
cd main && bun run scripts/export-batch-for-gemini.ts
```

### 2. AI 분석 및 결과 생성 (JSON -> JSON)
Haiku subagent를 띄워 `batch_to_filter.json`을 직접 분석하여 `filtered_results.json`을 생성합니다.
분석 완료 후 [총 데이터 수, 통과 수, 제외 수]를 보고합니다.

**subagent 프롬프트 (model: haiku)**
```
batch_to_filter.json을 읽어서 각 항목을 분석하고 filtered_results.json으로 저장해줘.

이 서비스는 전국 주차장 난이도 지도야. 각 항목은 블로그/카페 글이고,
해당 장소의 주차 경험/정보가 담겨 있는지 판단해야 해.

filterPassed 판단 기준:
- true: 해당 장소의 주차에 대한 실질적인 정보 포함
  (난이도/경험, 유무, 무료/유료, 운영시간, 요금, 규모, 접근성 등)
- false: 주차와 무관한 콘텐츠 (부동산, 채용, 뉴스, 단순 주소 나열 등)

나머지 필드(sentimentScore, difficultyKeywords, summary)는 네 판단으로 채워줘.
완료 후 [총 건수, 통과, 제외] 보고.
```

**출력 포맷 (`filtered_results.json`)**
```json
{
  "results": [
    {
      "id": 12345,
      "filterPassed": true,
      "sentimentScore": 4,
      "summary": "전용 주차장 있어 편리함",
      "difficultyKeywords": ["전용주차장", "무료"]
    }
  ]
}
```

- `filterPassed`: 주차 관련 유의미한 정보가 있으면 `true`, 무관한 콘텐츠(부동산, 음식점 소개 등)면 `false`
- `sentimentScore`: 1~5 (1=주차 매우 어려움, 5=주차 매우 쉬움)
- `difficultyKeywords`: 주차 난이도 관련 키워드 배열 (예: `"협소"`, `"무료"`, `"공영"`, `"만차"`)
- `summary`: 주차 관련 핵심 내용 한 줄 요약 (한국어)

### 3. 결과 반영 (JSON -> Remote DB)
리모트 DB의 안정성을 위해 결과를 250개 단위로 분할하여 반영합니다. (총 4회 분할)
```bash
# 250개씩 분할된 SQL 파일 생성 후 순차 실행
cd main && node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync("filtered_results.json", "utf8")).results;
const chunkSize = 250;
for (let i = 0; i < data.length; i += chunkSize) {
  const chunk = data.slice(i, i + chunkSize);
  let sql = "";
  chunk.forEach(res => {
    const keywords = JSON.stringify(res.difficultyKeywords).replace(/\x27/g, "\x27\x27");
    const summary = res.summary.replace(/\x27/g, "\x27\x27");
    const passed = res.filterPassed ? 1 : 0;
    sql += `UPDATE web_sources_raw SET filter_passed = ${passed}, sentiment_score = ${res.sentimentScore}, ai_difficulty_keywords = \x27${keywords}\x27, ai_summary = \x27${summary}\x27, ai_filtered_at = datetime("now") WHERE id = ${res.id};\n`;
  });
  fs.writeFileSync(`update_part${Math.floor(i/chunkSize) + 1}.sql`, sql);
}
'
# 생성된 파일 순차 실행 (예: part1, part2)
echo "Y" | npx wrangler d1 execute parking-db --remote --file=update_part1.sql
echo "Y" | npx wrangler d1 execute parking-db --remote --file=update_part2.sql
```

## 주의사항
- `filtered_results.json` 파일의 `id` 값이 `batch_to_filter.json`과 일치하는지 확인하십시오.
- 리모트 반영 전 업데이트 개수가 예상과 맞는지 로그를 확인하십시오.
