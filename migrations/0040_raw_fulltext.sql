-- web_sources_raw에 fulltext 컬럼 추가
-- raw 단계에서 fulltext를 먼저 채운 후 AI 필터를 적용하기 위함 (#149)
ALTER TABLE web_sources_raw ADD COLUMN full_text TEXT;
ALTER TABLE web_sources_raw ADD COLUMN full_text_status TEXT DEFAULT 'pending';
ALTER TABLE web_sources_raw ADD COLUMN full_text_fetched_at TEXT;
ALTER TABLE web_sources_raw ADD COLUMN filter_tier TEXT; -- 'high'|'medium'|'low' (rule filter 결과)

CREATE INDEX IF NOT EXISTS idx_raw_fulltext_status ON web_sources_raw(full_text_status, ai_filtered_at);
