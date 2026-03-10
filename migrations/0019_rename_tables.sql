-- reviews → user_reviews, crawled_reviews → web_sources
ALTER TABLE reviews RENAME TO user_reviews;
ALTER TABLE crawled_reviews RENAME TO web_sources;
