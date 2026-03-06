-- reviews 테이블 확장: 회원/비회원 리뷰 지원
ALTER TABLE reviews ADD COLUMN user_id TEXT;
ALTER TABLE reviews ADD COLUMN guest_nickname TEXT;
ALTER TABLE reviews ADD COLUMN ip_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_reviews_user_id ON reviews(user_id);
