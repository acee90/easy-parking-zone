-- 주차장 큐레이션 태그 (헬/초보추천)
ALTER TABLE parking_lots ADD COLUMN is_curated INTEGER NOT NULL DEFAULT 0;
ALTER TABLE parking_lots ADD COLUMN curation_tag TEXT;     -- 'hell' | 'easy' | null
ALTER TABLE parking_lots ADD COLUMN curation_reason TEXT;   -- "골뱅이 나선형", "넓은 평면" 등

-- Seed 리뷰 구분 플래그
ALTER TABLE reviews ADD COLUMN is_seed INTEGER NOT NULL DEFAULT 0;

-- 주차장 미디어 (YouTube 영상, 이미지 등)
CREATE TABLE IF NOT EXISTS parking_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id TEXT NOT NULL REFERENCES parking_lots(id),
  media_type TEXT NOT NULL,           -- 'youtube' | 'image' | 'streetview'
  url TEXT NOT NULL,
  title TEXT,
  thumbnail_url TEXT,
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_parking_media_lot ON parking_media(parking_lot_id);
