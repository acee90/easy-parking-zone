-- AI 필터링 보강 컬럼 (Haiku)
-- filter_passed / filter_removed_by / sentiment_score는 기존 컬럼 재활용
ALTER TABLE web_sources ADD COLUMN ai_difficulty_keywords TEXT;  -- JSON 배열 ["좁다","기계식","경사"]
ALTER TABLE web_sources ADD COLUMN ai_summary TEXT;              -- 한줄 요약
ALTER TABLE web_sources ADD COLUMN ai_filtered_at TEXT;          -- AI 분류 시각
