-- web_sources.is_ad 컬럼 제거 (AI 필터 파이프라인으로 대체)
-- web_sources.filter_passed 컬럼 제거 (web_sources에는 통과분만 존재)
ALTER TABLE web_sources DROP COLUMN is_ad;
ALTER TABLE web_sources DROP COLUMN filter_passed;
ALTER TABLE web_sources DROP COLUMN filter_removed_by;
