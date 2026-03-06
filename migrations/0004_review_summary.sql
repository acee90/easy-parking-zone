-- 리뷰 요약 사전 계산 칼럼 추가
ALTER TABLE crawled_reviews ADD COLUMN summary TEXT;
ALTER TABLE crawled_reviews ADD COLUMN is_positive INTEGER;
