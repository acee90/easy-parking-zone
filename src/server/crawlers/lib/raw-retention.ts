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
 * 검수 표본으로 남길 탈락 행의 비율(1/N)과 보존 기간(일).
 *
 * 왜 남기는가: 필터를 강화할지 완화할지는 **버린 것을 봐야** 정해진다.
 * 통과분만 보면 false positive 만 보이고, "좋은 글을 버리고 있는지"(false negative)는
 * 영영 알 수 없다. 탈락 행을 즉시 지우면 그 표본이 사라진다.
 *
 * 크기: 유입 약 2,000행/일 × 1% × 30일 ≈ 600행. 본문까지 들고 있어도 7MB 수준이다.
 * `id % 100` 은 결정적이라 실행 시점과 무관하게 같은 행이 뽑힌다 — 재현 가능한 표본이다.
 *
 * 검수 절차는 docs/references/pipeline-quality-check.md 가 갖는다.
 */
export const AUDIT_SAMPLE_MODULUS = 100
export const AUDIT_SAMPLE_RETENTION_DAYS = 30

/** 검수 표본으로 보존할 행 (탈락분만 — 통과분의 사본은 web_sources 에 있다) */
const AUDIT_SAMPLE_CONDITION = `(
  r.filter_passed = 0
  AND r.id % ${AUDIT_SAMPLE_MODULUS} = 0
  AND r.crawled_at >= datetime('now', '-${AUDIT_SAMPLE_RETENTION_DAYS} day')
)`

/**
 * 종결 행을 고르는 SQL 조건. `web_sources_raw` 를 `r` 로 별칭한 쿼리에서 쓴다.
 *
 * 크론(scheduled.ts)과 일괄 정리 스크립트(scripts/cleanup-terminal-raw.ts)가
 * **같은 상수**를 쓴다. 두 벌로 갈라지면 한쪽만 고치는 일이 반복된다.
 *
 * ⚠️ 이 조건은 SQL 3값 논리 위에서 돈다. filter_passed 가 NULL 인 행(youtube_video)은
 *    `filter_passed = 0` 이 NULL 이라 조건 전체가 NULL 이 되고, WHERE 는 TRUE 만
 *    통과시키므로 지워지지 않는다 — 의도한 동작이다. 다만 `NOT (이 조건)` 으로 보존
 *    행수를 세면 그 행들이 양쪽 어디에도 안 잡힌다. 보존 수는 전체에서 빼서 구할 것.
 */
export const TERMINAL_RAW_CONDITION = `(
  (
    r.filter_passed = 0
    OR r.matched_at IS NOT NULL
    OR r.full_text_status IN (${FAILED_FULL_TEXT_STATUSES.map((s) => `'${s}'`).join(', ')})
  )
  AND NOT ${AUDIT_SAMPLE_CONDITION}
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
