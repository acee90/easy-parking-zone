/**
 * web_sources_raw 보존 정책 — single source of truth
 *
 * `web_sources_raw` 는 **가공 전 임시 데이터**다. 마이그레이션 셋이 이 전제로 깔려 있다.
 *   0049 — web_sources.matched_at 추가 (raw 를 지워도 스코어링이 대상을 찾도록)
 *   0050 — seen_sources 분리 (raw 를 지워도 "이미 크롤함" 기억이 남도록)
 *   0051 — raw 로 향하는 FK 제거 (DELETE 가 FK 에 막히지 않도록)
 *
 * 그런데 정작 **DELETE 를 쓰는 코드가 없었다.** 크론 6단계는 본문 테이블
 * (`web_sources_raw_body`)만 지우고 원장 행은 `full_text_status='purged'` 로
 * 표시만 했다. 결과: 2026-09-04 실측 152,085행 중 150,336행이 할 일이 끝난 채
 * 영구 잔류, 하루 1,600~2,300행씩 증가.
 *
 * ── 종결(terminal)의 정의 ──
 *
 *   filter_passed = 0                → 룰 필터 탈락. 다시 볼 일 없다.
 *   matched_at IS NOT NULL           → 매칭 완료. 정제 결과는 web_sources 에 있다.
 *   full_text_status IN (실패 4종)   → 본문 수집이 끝내 실패. 재시도 경로가 없다
 *                                      (raw-fulltext-batch 는 'pending' 만 본다).
 *
 * ⚠️ 여기에 `ai_filtered_at IS NOT NULL` 을 넣지 말 것.
 *    그 값은 AI 가 아니라 룰 필터가 찍고, 통과(=1)한 행은 매칭 단계가 아직 본문을
 *    필요로 한다. 넣으면 매칭 대기 행이 통째로 사라진다 (2026-06-09 사고와 같은 구조).
 *
 * ⚠️ youtube_video 는 종결이 아니다.
 *    크론 필터가 `source != 'youtube_video'` 로 제외해 filter_passed 가 영영 NULL 이라,
 *    별도 검증 스크립트(extract/apply-youtube-verify)가 처리하기 전까지 보존해야 한다.
 *    이 조건이 그 행들을 자동으로 비켜간다 — 상태가 'ok' 라 실패 4종에 안 걸리고,
 *    filter_passed 는 NULL 이라 `= 0` 에도 안 걸린다.
 */

/** 본문 수집이 끝내 실패해 재시도 경로가 없는 상태들 */
export const FAILED_FULL_TEXT_STATUSES = [
  'error',
  'timeout',
  'too_short',
  'not_found',
  'blocked',
] as const

/**
 * 종결 행을 고르는 SQL 조건. `web_sources_raw` 를 `r` 로 별칭한 쿼리에서 쓴다.
 *
 * 크론(scheduled.ts)과 일괄 정리 스크립트(scripts/cleanup-terminal-raw.ts)가
 * **같은 상수**를 쓴다. 두 벌로 갈라지면 한쪽만 고치는 일이 반복된다.
 */
export const TERMINAL_RAW_CONDITION = `(
  r.filter_passed = 0
  OR r.matched_at IS NOT NULL
  OR r.full_text_status IN (${FAILED_FULL_TEXT_STATUSES.map((s) => `'${s}'`).join(', ')})
)`

/**
 * 크론 1회가 지우는 최대 원장 행수.
 *
 * 정상 유입은 하루 1,600~2,300행 = 회당(2시간) 약 160행이라 여유가 10배다.
 * 상한을 두는 이유는 백로그 정리 때문이다 — 15만 행을 한 트랜잭션에 지우면
 * 그 회차의 rows_written 이 통째로 그 일에 묶인다. 백로그는 일괄 스크립트가 맡고,
 * 크론은 정상 유입만 따라가면 된다.
 */
export const RAW_DELETE_LIMIT_PER_RUN = 2000
