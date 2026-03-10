-- 어드민 리뷰 목록 조회 최적화: source_type IS NULL + created_at DESC
CREATE INDEX IF NOT EXISTS idx_reviews_source_created
  ON reviews(source_type, created_at DESC);
