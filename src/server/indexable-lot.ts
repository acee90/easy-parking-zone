/**
 * 색인 대상 lot 술어 — sitemap 과 /wiki/all 이 같은 기준을 쓰도록 한 곳에 둔다.
 *
 * 별칭 전제: `parking_lots p` + `LEFT JOIN parking_lot_stats s`.
 *
 * ## 왜 이 술어인가 (2026-09-09)
 *
 * 이전 술어에는 네 번째 가지가 있었다.
 *
 *   OR ( (total_spaces>0) + (phone非빈) + (is_free IS NOT NULL) + (curation_tag非NULL) ) >= 3
 *
 * `is_free` 는 `notNull().default(false)`(schema.ts) 라 `IS NOT NULL` 이 **항상 참**이다.
 * 실질적으로 나머지 3개 중 2개 — 면수와 전화번호만 있으면 통과했다. 콘텐츠 신호가 아니다.
 * remote D1 전수 확인 결과 이 가지 하나로 16,706 lot 이 들어와, sitemap 이 20,286 이 됐다.
 * 새 술어는 6,397 이다.
 *
 * ## 왜 지금 줄이는가
 *
 * GSC 크롤링 통계(26.6.11~26.9.7): 총 962건 = **하루 10.9건**, 평균 응답 220ms, 상태 정상.
 * 크롤 용량이 아니라 크롤 수요가 한계다. 그 하루 10.9건 중 색인 후보에 닿는 건 1.3건뿐이었다
 * (6,397 / 크롤 대상 54,600). 대상을 줄이면 같은 10.9건으로 10.8건이 색인 후보에 닿는다.
 *
 * ## 고칠 때 주의
 *
 * 이 상수를 쓰는 곳이 sitemap 의 **개수 쿼리와 페이지 쿼리 두 곳**이다. 둘이 어긋나면
 * sitemap index 의 pageCount 와 실제 URL 수가 맞지 않는다. 상수 하나로 묶은 이유다.
 *
 * ## 네 가지 가지
 *
 * 1. 웹 출처 — `filter_passed_v2 IS NOT 0` 으로 정보 모음 사이트(경쟁사) 행만 있는 lot 을 제외한다.
 * 2. lot AI 요약
 * 3. 큐레이션 사유
 * 4. 실유저 리뷰 — 시드(`is_seed=1`)는 자체 콘텐츠가 아니라 제외한다.
 *
 * SQL 안에 `--` 주석을 두지 않는다. 공백이 한 줄로 접히는 경로가 생기면
 * 뒤쪽 조건이 통째로 주석 처리돼 조용히 전부 통과시킨다.
 *
 * 자세한 근거: docs/exec-plans/own-content-strategy-delta-2026-09-09.md
 */
export const INDEXABLE_LOT_SQL = `(
  EXISTS (SELECT 1 FROM web_sources ws
          WHERE ws.parking_lot_id = p.id AND ws.filter_passed_v2 IS NOT 0)
  OR s.ai_summary IS NOT NULL
  OR p.curation_reason IS NOT NULL
  OR EXISTS (SELECT 1 FROM user_reviews r
             WHERE r.parking_lot_id = p.id AND r.is_seed = 0)
)`
