-- web_sources 테이블에 연속 감성 점수 컬럼 추가
-- 기존 is_positive (0/1)와 별도로 1.0~5.0 연속값 저장
ALTER TABLE web_sources ADD COLUMN sentiment_score REAL;
