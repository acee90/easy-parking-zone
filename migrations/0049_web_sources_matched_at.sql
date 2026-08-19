-- web_sources에 matched_at을 추가해 web_sources_raw 의존을 끊는다.
--
-- 배경: 스코어링 재계산이 아래처럼 raw를 JOIN해서 "최근 매칭분"을 찾고 있었다.
--   SELECT DISTINCT ws.parking_lot_id FROM web_sources ws
--     JOIN web_sources_raw r ON r.id = ws.raw_source_id
--    WHERE r.matched_at > ?
-- web_sources_raw를 처리 완료 후 삭제하는 구조(가공 전 임시 데이터)로 가면 이 JOIN이
-- 아무것도 못 찾아 **에러 없이 0건**이 되어 평점 재계산이 조용히 멈춘다.
-- web_sources가 자기완결적으로 매칭 시각을 갖도록 해서 이 결합을 제거한다.
--
-- 기존 행은 raw에서 값을 회수하고, raw가 이미 없는 행은 crawled_at으로 대체한다.

ALTER TABLE web_sources ADD COLUMN matched_at TEXT;

-- ⚠️ 기존 버그도 함께 고친다: web_sources_raw.matched_at에 문자열 'backfill'이
--    900행 들어있다(local·remote 동일). 스코어링은 `WHERE r.matched_at > <날짜>`로
--    비교하는데 문자열 비교에서 'backfill' > 모든 날짜라 **항상 참**이다.
--    그 결과 해당 231개 주차장이 30분마다 영구 재계산되고 있었다.
--    날짜 형식인 값만 채택하고, 아니면 NULL로 둔다(=재계산 대상 아님, 이미 계산됨).
UPDATE web_sources
   SET matched_at = COALESCE(
     (SELECT CASE WHEN r.matched_at GLOB '[0-9][0-9][0-9][0-9]-*' THEN r.matched_at END
        FROM web_sources_raw r WHERE r.id = web_sources.raw_source_id),
     CASE WHEN crawled_at GLOB '[0-9][0-9][0-9][0-9]-*' THEN crawled_at END
   )
 WHERE matched_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ws_matched_at ON web_sources(matched_at);
