# Reliability

> 최종 업데이트: 2026-04-14

운영 안정성, 모니터링, 장애 대응 가이드.

## Infrastructure

| 컴포넌트 | 서비스 | SLA |
|----------|--------|-----|
| SSR + API | Cloudflare Workers | 99.9% |
| Database | Cloudflare D1 | 99.9% |
| Cron Jobs | Workers Cron Triggers | Best effort |
| DNS + CDN | Cloudflare | 99.9% |

## Cron Pipeline Health

매시간 실행. 한 단계 실패해도 다른 단계는 독립 실행.

```
크롤링 → AI 필터 → 매칭 → 스코어링
  각 단계 try-catch 독립 — 부분 실패 허용
```

### 모니터링 포인트

| 지표 | 확인 방법 | 경고 기준 |
|------|----------|----------|
| Cron 실행 여부 | Workers Logs | 2시간 이상 로그 없음 |
| AI 필터 미처리 | `SELECT COUNT(*) FROM web_sources_raw WHERE ai_filtered_at IS NULL` | 1,000건 이상 적체 |
| 매칭 미처리 | `SELECT COUNT(*) FROM web_sources_raw WHERE filter_passed=1 AND matched_at IS NULL` | 500건 이상 적체 |
| D1 용량 | wrangler d1 info | 225MB / 500MB (Free plan) |
| API 키 유효성 | Cron 로그 에러 | 연속 3회 실패 |

## Cache Strategy

| 대상 | TTL | 저장소 |
|------|-----|--------|
| Site Stats (주차장/리뷰/포스팅 수) | 6시간 | Cache API |
| 지도 타일 | Naver 기본값 | Naver CDN |
| Static Assets | 1년 | Cloudflare CDN |

## Known Limits

| 제약 | 값 | 영향 |
|------|-----|------|
| Workers CPU time (Free) | 10ms | Cron에서 대량 처리 제한 |
| Workers wall time (Free) | 30초 | AI 필터 배치 100건 제한 |
| D1 storage (Free) | 500MB | 현재 225MB 사용 |
| D1 rows read/day (Free) | 5M | 대량 쿼리 주의 |
| Subrequests/invocation | 1,000 | DDG 크롤러 별도 cron 분리 이유 |

## Incident Response

### D1 용량 초과 임박

1. `web_sources_raw`에서 `filter_passed=0` 오래된 건 DELETE
2. `full_text`, `full_text_length` 컬럼 데이터 정리 검토
3. D1 paid plan 전환 검토 (5GB)

### Cron 장시간 미실행

1. Workers 대시보드에서 Cron Trigger 상태 확인
2. wrangler tail로 실시간 로그 확인
3. 수동 실행: `curl -X POST https://easy-parking.xyz/__scheduled`

### API 키 만료

1. Cloudflare Secrets 재설정: `wrangler secret put <KEY_NAME>`
2. 재배포 불필요 (Secrets는 즉시 반영)
