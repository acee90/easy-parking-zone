-- #148 Phase C — full_text 기반 filter + relevance v2
-- 기존 relevance_score / raw 단계 filter 결과는 보존. v2 컬럼은 부가 정보.
ALTER TABLE web_sources ADD COLUMN relevance_score_v2 INTEGER;
ALTER TABLE web_sources ADD COLUMN filter_passed_v2 INTEGER;
ALTER TABLE web_sources ADD COLUMN filter_v2_reason TEXT;
ALTER TABLE web_sources ADD COLUMN filter_v2_evaluated_at TEXT;

-- pending row 빠르게 찾기 (filter_passed_v2 IS NULL AND full_text_status='ok')
CREATE INDEX IF NOT EXISTS idx_ws_filter_v2_pending
  ON web_sources(filter_passed_v2, full_text_status, source);

-- v2 통과 subset 빠르게 조회 (#141 입력)
CREATE INDEX IF NOT EXISTS idx_ws_filter_v2_passed
  ON web_sources(filter_passed_v2, relevance_score_v2);
