-- web_sources.ai_summary 생성 시도 시각을 마킹해서 실패한 row의 재시도를 막는다.
-- run-ai-summary Phase 1에서 too_short이고 기존 summary도 없는 row를 마킹하는 데 사용.
ALTER TABLE web_sources ADD COLUMN ai_summary_updated_at TEXT;
