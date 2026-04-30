# Quality Score

> 최종 업데이트: 2026-04-14

코드 품질 기준과 기술 부채 관리 문서.

## Quality Metrics

### Test Coverage

| 영역 | 현재 | 목표 | 비고 |
|------|------|------|------|
| Unit Tests | Low | Medium | Vitest + @testing-library/react |
| Integration Tests | None | Low | D1 바인딩 테스트 필요 |
| E2E Tests | None | Low | Playwright 검토 |

### Build Health

- `bun --bun run build` — 빌드 성공 필수 (CI 게이트)
- GitHub Actions CI — PR 시 자동 build/test 실행 (`.github/workflows/ci.yml`)
- TypeScript strict mode — 타입 에러 0
- Bundle size 모니터링 — `worker-entry` 889KB (주시)

## Code Quality Standards

### Must

- TypeScript strict — `any` 사용 금지 (불가피한 경우 주석)
- SQL injection 방지 — 파라미터 바인딩 필수, raw SQL에 변수 직접 삽입 금지
- Import 정리 — 미사용 import 잔류 금지

### Should

- 함수 단일 책임 — 100줄 초과 시 분리 검토
- 매직 넘버 지양 — 상수 추출 (MAX_PER_RUN, BATCH_SIZE 등)
- 에러 메시지 한글 — 사용자 노출 에러는 한글, 내부 로그는 영문 가능

### Avoid

- 추측성 추상화 — 1회 사용 코드에 인터페이스/팩토리 금지
- 과도한 에러 핸들링 — 발생 불가능한 시나리오에 try-catch 금지
- 데드 코드 — 사용하지 않는 코드는 커밋하지 않음

## Technical Debt Tracker

| ID | 항목 | 심각도 | 상태 | 비고 |
|----|------|--------|------|------|
| TD-001 | worker-entry 번들 889KB | Medium | Open | 코드 스플리팅 검토 |
| TD-002 | 어드민 SQL raw 쿼리 | Low | Open | Drizzle ORM 전환 검토 |
| TD-003 | schema.ts의 isPositive 레거시 컬럼 | Low | Open | is_ad 제거 완료(0029), is_positive는 schema에 잔류 — 실제 사용 여부 확인 후 마이그레이션 제거 필요 |
| TD-004 | 테스트 커버리지 부족 | Medium | Open | scoring.test.ts 257줄 추가(2026-04-13), 핵심 로직 일부 커버 — sentiment/transforms 확대 필요 |
| TD-005 | 어드민 SQL raw 쿼리 (Drizzle 미전환) | Low | Open | admin.ts 일부 기능 raw SQL — Drizzle 전환 미완 |

## Quality Checklist (PR 전)

- [ ] `bun --bun run build` 성공
- [ ] `bun --bun run test` 통과
- [ ] TypeScript 에러 0
- [ ] 미사용 import/변수 없음
- [ ] 새 SQL에 파라미터 바인딩 사용
