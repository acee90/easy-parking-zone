-- AI가 web_sources + user_reviews를 압축한 주차장 한 줄 요약
ALTER TABLE parking_lot_stats ADD COLUMN ai_summary TEXT;
ALTER TABLE parking_lot_stats ADD COLUMN ai_summary_updated_at TEXT;
