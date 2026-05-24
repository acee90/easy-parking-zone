-- 0044에서 review_score/review_count/web_score/web_count 신 컬럼 추가 + 백필 완료.
-- 코드 (src/server/parking.ts, scoring-engine.ts 등)는 모두 신 컬럼만 참조.
-- recompute 큐가 신 컬럼만 갱신하므로 구 컬럼은 stale 위험.
-- 검증: 3/11 이후 user_reviews 14건 중 4건이 user_review_count=0(구) / review_count=정확(신)으로 확인됨.
-- → 구 컬럼 제거.

ALTER TABLE parking_lot_stats DROP COLUMN user_review_score;
ALTER TABLE parking_lot_stats DROP COLUMN user_review_count;
ALTER TABLE parking_lot_stats DROP COLUMN community_score;
ALTER TABLE parking_lot_stats DROP COLUMN community_count;
ALTER TABLE parking_lot_stats DROP COLUMN text_sentiment_score;
ALTER TABLE parking_lot_stats DROP COLUMN text_source_count;
