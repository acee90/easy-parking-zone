-- web_sources의 fulltext 관련 4개 컬럼 제거 (#149 이후 미사용 레거시).
-- full_text는 web_sources_raw에만 보존하고, web_sources는 raw_source_id로 raw를 참조한다.
-- 실측: remote ws 7,967행 중 full_text 보유 3행(~20KB) — 사실상 잔재. 활성 cron 경로는 web_sources_raw만 조회.
-- full_text_status를 참조하던 인덱스 2개를 먼저 제거한다 (구 v2-filter 경로용, raw 이전으로 무의미).
DROP INDEX IF EXISTS idx_ws_fulltext_status;
DROP INDEX IF EXISTS idx_ws_filter_v2_pending;
ALTER TABLE web_sources DROP COLUMN full_text;
ALTER TABLE web_sources DROP COLUMN full_text_length;
ALTER TABLE web_sources DROP COLUMN full_text_status;
ALTER TABLE web_sources DROP COLUMN full_text_fetched_at;
