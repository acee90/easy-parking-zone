-- Consolidated scoring axes for review-triggered recompute.
-- Legacy columns (user_review_*, community_*, text_*) remain in the DB for
-- compatibility/backfill, but new writers/readers should use these columns.

ALTER TABLE parking_lot_stats ADD COLUMN review_score REAL;
ALTER TABLE parking_lot_stats ADD COLUMN review_count INTEGER DEFAULT 0;
ALTER TABLE parking_lot_stats ADD COLUMN web_score REAL;
ALTER TABLE parking_lot_stats ADD COLUMN web_count INTEGER DEFAULT 0;

-- Best-effort backfill from existing split axes.
UPDATE parking_lot_stats
SET
  review_count = COALESCE(user_review_count, 0) + COALESCE(community_count, 0),
  review_score = CASE
    WHEN
      (CASE WHEN user_review_score IS NOT NULL THEN COALESCE(user_review_count, 0) ELSE 0 END) +
      (CASE WHEN community_score IS NOT NULL THEN COALESCE(community_count, 0) ELSE 0 END) > 0
    THEN
      (
        COALESCE(user_review_score, 0) *
          (CASE WHEN user_review_score IS NOT NULL THEN COALESCE(user_review_count, 0) ELSE 0 END) +
        COALESCE(community_score, 0) *
          (CASE WHEN community_score IS NOT NULL THEN COALESCE(community_count, 0) ELSE 0 END)
      ) / (
        (CASE WHEN user_review_score IS NOT NULL THEN COALESCE(user_review_count, 0) ELSE 0 END) +
        (CASE WHEN community_score IS NOT NULL THEN COALESCE(community_count, 0) ELSE 0 END)
      )
    ELSE NULL
  END,
  web_score = text_sentiment_score,
  web_count = COALESCE(text_source_count, 0)
WHERE
  review_score IS NULL
  AND review_count = 0
  AND web_score IS NULL
  AND web_count = 0;
