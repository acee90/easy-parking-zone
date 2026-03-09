-- 수집 데이터 기반 큐레이션 후보 테이블
-- 카페 심화, YouTube 등 다양한 소스의 집계 결과 저장
CREATE TABLE IF NOT EXISTS curation_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parking_lot_id TEXT NOT NULL,
  source TEXT NOT NULL,              -- 'cafe_community', 'youtube', etc.
  mentions INTEGER NOT NULL DEFAULT 0,
  positive INTEGER NOT NULL DEFAULT 0,
  negative INTEGER NOT NULL DEFAULT 0,
  neutral INTEGER NOT NULL DEFAULT 0,
  sample_titles TEXT,                -- JSON array
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'approved_hell' | 'approved_easy' | 'dismissed'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(parking_lot_id, source)
);

-- admin 권한 관리
ALTER TABLE "user" ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
