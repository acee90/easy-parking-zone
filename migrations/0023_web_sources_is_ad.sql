-- web_sources에 광고 판별 플래그 추가
ALTER TABLE web_sources ADD COLUMN is_ad INTEGER NOT NULL DEFAULT 0;
