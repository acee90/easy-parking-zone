# Review

> 최종 업데이트: 2026-04-02

코드 리뷰 체크리스트 및 PR 기준.

## PR Checklist

### Required

- [ ] 빌드 성공 (`bun --bun run build`)
- [ ] 테스트 통과 (`bun --bun run test`)
- [ ] 변경 범위가 PR 제목/설명과 일치
- [ ] 불필요한 파일 변경 없음 (auto-generated, config 등)

### Code Quality

- [ ] 새 함수/컴포넌트에 명확한 이름
- [ ] 매직 넘버 → 이름 있는 상수
- [ ] 중복 코드 3회 이상 반복 시 추출 검토
- [ ] console.log 디버깅 코드 제거

### Database

- [ ] SQL에 파라미터 바인딩 사용 (injection 방지)
- [ ] 새 컬럼/테이블 → migration 파일 포함
- [ ] D1 batch 사용 시 500건 제한 준수
- [ ] 인덱스 필요 여부 확인 (WHERE/JOIN 대상 컬럼)

### Frontend

- [ ] shadcn/ui 컴포넌트 직접 수정 없음 (`src/components/ui/`)
- [ ] Tailwind 클래스 → `cn()` 유틸리티 사용
- [ ] 반응형 대응 (모바일 우선)
- [ ] 사용자 노출 텍스트 한글

### Crawling Pipeline

- [ ] `web_sources_raw` INSERT 시 `INSERT OR IGNORE` 사용
- [ ] `web_sources` INSERT 시 `raw_source_id` 연결
- [ ] API rate limit 준수 (sleep/backoff)
- [ ] Workers wall time 30초 이내

## Commit Convention

```
<emoji> <한글 요약>

<상세 설명 (선택)>
```

| Emoji | 용도 |
|-------|------|
| :sparkles: | 새 기능 |
| :wrench: | 기존 기능 개선/수정 |
| :bug: | 버그 수정 |
| :wastebasket: | 코드/데이터 정리 |
| :broom: | 리팩토링 |
| :memo: | 문서 |

## Review Focus by Area

| 변경 영역 | 중점 확인 |
|----------|----------|
| `src/server/` | SQL injection, 인증 체크, 에러 핸들링 |
| `src/server/crawlers/` | Rate limit, wall time, 배치 크기 |
| `src/routes/` | SSR 호환성, loader 에러 처리 |
| `src/components/` | 접근성, 반응형, 성능 |
| `scripts/` | `--remote` 플래그 주의, 대량 변경 안전장치 |
| `migrations/` | 롤백 가능성, 기존 데이터 영향 |
