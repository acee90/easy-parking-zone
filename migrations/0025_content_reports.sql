-- 콘텐츠 신고 테이블 (웹소스/미디어/리뷰 통합)
CREATE TABLE IF NOT EXISTS content_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_type TEXT NOT NULL,        -- 'web_source' | 'media' | 'review'
  target_id INTEGER NOT NULL,       -- web_sources.id | parking_media.id | user_reviews.id
  parking_lot_id TEXT NOT NULL,
  reason TEXT NOT NULL,             -- 사유 코드
  detail TEXT,                      -- '기타' 선택 시 상세 사유
  ip_hash TEXT,                     -- 중복 신고 방지
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'resolved' | 'dismissed'
  admin_note TEXT,                  -- 관리자 메모
  resolved_by TEXT,                 -- admin user id
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_content_reports_status
  ON content_reports(status);
CREATE INDEX IF NOT EXISTS idx_content_reports_target
  ON content_reports(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_content_reports_lot
  ON content_reports(parking_lot_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_content_reports_ip_target
  ON content_reports(target_type, target_id, ip_hash);
