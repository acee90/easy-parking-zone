import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

const now = sql`(datetime('now'))`

// ============================================================
// Auth (better-auth 관리 — 스키마 정의만, 쿼리는 better-auth가 직접 처리)
// ============================================================

export const users = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('emailVerified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  isAdmin: integer('is_admin', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('createdAt').notNull().default(now),
  updatedAt: text('updatedAt').notNull().default(now),
})

export const accounts = sqliteTable('account', {
  id: text('id').primaryKey(),
  userId: text('userId')
    .notNull()
    .references(() => users.id),
  accountId: text('accountId').notNull(),
  providerId: text('providerId').notNull(),
  accessToken: text('accessToken'),
  refreshToken: text('refreshToken'),
  accessTokenExpiresAt: text('accessTokenExpiresAt'),
  refreshTokenExpiresAt: text('refreshTokenExpiresAt'),
  scope: text('scope'),
  idToken: text('idToken'),
  password: text('password'),
  createdAt: text('createdAt').notNull().default(now),
  updatedAt: text('updatedAt').notNull().default(now),
})

export const sessions = sqliteTable('session', {
  id: text('id').primaryKey(),
  userId: text('userId')
    .notNull()
    .references(() => users.id),
  token: text('token').notNull().unique(),
  expiresAt: text('expiresAt').notNull(),
  ipAddress: text('ipAddress'),
  userAgent: text('userAgent'),
  createdAt: text('createdAt').notNull().default(now),
  updatedAt: text('updatedAt').notNull().default(now),
})

export const verifications = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: text('expiresAt').notNull(),
  createdAt: text('createdAt').notNull().default(now),
  updatedAt: text('updatedAt').notNull().default(now),
})

// ============================================================
// 주차장
// ============================================================

export const parkingLots = sqliteTable(
  'parking_lots',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull(), // 노상/노외/부설
    address: text('address').notNull(),
    lat: real('lat').notNull(),
    lng: real('lng').notNull(),
    totalSpaces: integer('total_spaces').notNull().default(0),
    freeSpaces: integer('free_spaces'),

    // 운영시간
    weekdayStart: text('weekday_start'),
    weekdayEnd: text('weekday_end'),
    saturdayStart: text('saturday_start'),
    saturdayEnd: text('saturday_end'),
    holidayStart: text('holiday_start'),
    holidayEnd: text('holiday_end'),

    // 요금
    isFree: integer('is_free', { mode: 'boolean' }).notNull().default(false),
    baseTime: integer('base_time'),
    baseFee: integer('base_fee'),
    extraTime: integer('extra_time'),
    extraFee: integer('extra_fee'),
    dailyMax: integer('daily_max'),
    monthlyPass: integer('monthly_pass'),

    // 난이도
    autoDifficultyScore: real('auto_difficulty_score').notNull().default(3.0),

    phone: text('phone'),
    paymentMethods: text('payment_methods'),
    notes: text('notes'),

    // 큐레이션
    isCurated: integer('is_curated', { mode: 'boolean' }).notNull().default(false),
    curationTag: text('curation_tag'),
    curationReason: text('curation_reason'),
    featuredSource: text('featured_source'),

    // POI
    poiTags: text('poi_tags'), // JSON array

    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (table) => [
    index('idx_parking_lots_lat').on(table.lat),
    index('idx_parking_lots_lng').on(table.lng),
  ],
)

// ============================================================
// 주차장 통합 점수 (사전 계산)
// ============================================================

export const parkingLotStats = sqliteTable('parking_lot_stats', {
  parkingLotId: text('parking_lot_id')
    .primaryKey()
    .references(() => parkingLots.id),
  structuralPrior: real('structural_prior'),
  userReviewScore: real('user_review_score'),
  userReviewCount: integer('user_review_count').default(0),
  communityScore: real('community_score'),
  communityCount: integer('community_count').default(0),
  textSentimentScore: real('text_sentiment_score'),
  textSourceCount: integer('text_source_count').default(0),
  nEffective: real('n_effective').default(0),
  finalScore: real('final_score'),
  reliability: text('reliability'),
  computedAt: text('computed_at').default(now),
})

// ============================================================
// 리뷰
// ============================================================

export const userReviews = sqliteTable(
  'user_reviews',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    parkingLotId: text('parking_lot_id')
      .notNull()
      .references(() => parkingLots.id),
    userId: text('user_id'),
    guestNickname: text('guest_nickname'),
    ipHash: text('ip_hash'),
    entryScore: integer('entry_score').notNull(),
    spaceScore: integer('space_score').notNull(),
    passageScore: integer('passage_score').notNull(),
    exitScore: integer('exit_score').notNull(),
    overallScore: integer('overall_score').notNull(),
    comment: text('comment'),
    visitedAt: text('visited_at'),
    isSeed: integer('is_seed', { mode: 'boolean' }).notNull().default(false),
    sourceType: text('source_type'),
    sourceUrl: text('source_url'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [index('idx_user_reviews_lot').on(table.parkingLotId)],
)

// ============================================================
// 웹 소스 (블로그/카페/POI 크롤링)
// ============================================================

export const webSources = sqliteTable('web_sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  parkingLotId: text('parking_lot_id')
    .notNull()
    .references(() => parkingLots.id),
  source: text('source').notNull(), // naver_blog, naver_cafe, poi, youtube_comment, naver_place, brave_search, ddg_search, tistory_blog
  sourceId: text('source_id').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  sourceUrl: text('source_url').notNull(),
  author: text('author'),
  publishedAt: text('published_at'),
  relevanceScore: integer('relevance_score').notNull().default(0),
  summary: text('summary'),
  isPositive: integer('is_positive'),
  sentimentScore: real('sentiment_score'),

  crawledAt: text('crawled_at').notNull().default(now),
})

// ============================================================
// 미디어 (YouTube 등)
// ============================================================

export const parkingMedia = sqliteTable('parking_media', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  parkingLotId: text('parking_lot_id')
    .notNull()
    .references(() => parkingLots.id),
  mediaType: text('media_type').notNull(),
  url: text('url').notNull(),
  title: text('title'),
  thumbnailUrl: text('thumbnail_url'),
  description: text('description'),
  createdAt: text('created_at').notNull().default(now),
})

// ============================================================
// 투표 / 북마크
// ============================================================

export const parkingVotes = sqliteTable(
  'parking_votes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id').notNull(),
    parkingLotId: text('parking_lot_id').notNull(),
    voteType: text('vote_type').notNull(), // 'up' | 'down'
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [uniqueIndex('idx_parking_votes_unique').on(table.userId, table.parkingLotId)],
)

export const parkingBookmarks = sqliteTable(
  'parking_bookmarks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id').notNull(),
    parkingLotId: text('parking_lot_id').notNull(),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [uniqueIndex('idx_parking_bookmarks_unique').on(table.userId, table.parkingLotId)],
)

// ============================================================
// 리뷰 신고 (레거시)
// ============================================================

export const reviewReports = sqliteTable('review_reports', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceUrl: text('source_url').notNull(),
  parkingLotId: text('parking_lot_id').notNull(),
  reason: text('reason').notNull(),
  createdAt: text('created_at').notNull().default(now),
})

// ============================================================
// 콘텐츠 신고 (웹소스/미디어/리뷰 통합)
// ============================================================

export const contentReports = sqliteTable(
  'content_reports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    targetType: text('target_type').notNull(), // web_source | media | review
    targetId: integer('target_id').notNull(),
    parkingLotId: text('parking_lot_id').notNull(),
    reason: text('reason').notNull(),
    detail: text('detail'),
    ipHash: text('ip_hash'),
    status: text('status').notNull().default('pending'), // pending | resolved | dismissed
    adminNote: text('admin_note'),
    resolvedBy: text('resolved_by'),
    resolvedAt: text('resolved_at'),
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [
    index('idx_content_reports_status').on(table.status),
    index('idx_content_reports_target').on(table.targetType, table.targetId),
    index('idx_content_reports_lot').on(table.parkingLotId),
    uniqueIndex('uq_content_reports_ip_target').on(table.targetType, table.targetId, table.ipHash),
  ],
)

// ============================================================
// 카페 시그널 (크롤링 검수)
// ============================================================

export const cafeSignals = sqliteTable('cafe_signals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull().unique(),
  url: text('url').notNull(),
  snippet: text('snippet').notNull().default(''),
  aiSentiment: text('ai_sentiment').notNull().default('neutral'),
  humanScore: integer('human_score'),
  createdAt: text('created_at').notNull().default(now),
  updatedAt: text('updated_at').notNull().default(now),
})

export const cafeSignalLots = sqliteTable(
  'cafe_signal_lots',
  {
    signalId: integer('signal_id')
      .notNull()
      .references(() => cafeSignals.id, { onDelete: 'cascade' }),
    parkingLotId: text('parking_lot_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.signalId, table.parkingLotId] }),
    index('idx_cafe_signal_lots_parking').on(table.parkingLotId),
  ],
)

// ============================================================
// 크롤링 진행상황
// ============================================================

export const crawlProgress = sqliteTable('crawl_progress', {
  crawlerId: text('crawler_id').primaryKey(),
  lastParkingLotId: text('last_parking_lot_id'),
  completedCount: integer('completed_count').default(0),
  totalTarget: integer('total_target').default(0),
  lastRunAt: text('last_run_at'),
  metadata: text('metadata'), // JSON
})

// ============================================================
// 큐레이션 후보
// ============================================================

export const curationCandidates = sqliteTable(
  'curation_candidates',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    parkingLotId: text('parking_lot_id').notNull(),
    source: text('source').notNull(),
    mentions: integer('mentions').notNull().default(0),
    positive: integer('positive').notNull().default(0),
    negative: integer('negative').notNull().default(0),
    neutral: integer('neutral').notNull().default(0),
    sampleTitles: text('sample_titles'),
    status: text('status').notNull().default('pending'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (table) => [uniqueIndex('idx_curation_candidates_unique').on(table.parkingLotId, table.source)],
)

// ============================================================
// POI 매칭 실패
// ============================================================

export const poiUnmatched = sqliteTable(
  'poi_unmatched',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    poiName: text('poi_name').notNull(),
    lotName: text('lot_name').notNull(),
    poiLat: real('poi_lat').notNull(),
    poiLng: real('poi_lng').notNull(),
    category: text('category'),
    status: text('status').notNull().default('pending'), // pending | resolved | ignored
    resolvedLotId: text('resolved_lot_id'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (table) => [
    index('idx_poi_unmatched_status').on(table.status),
    uniqueIndex('idx_poi_unmatched_unique').on(table.poiName, table.lotName),
  ],
)

// ============================================================
// 주변 장소 (AI 추출)
// ============================================================

export const nearbyPlaces = sqliteTable(
  'nearby_places',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    parkingLotId: text('parking_lot_id')
      .notNull()
      .references(() => parkingLots.id),
    name: text('name').notNull(),
    category: text('category').notNull(), // cafe | restaurant | park | tourist | market | hospital | etc
    tip: text('tip'),
    mentionCount: integer('mention_count').notNull().default(1),
    sourceBlogIds: text('source_blog_ids'), // JSON array of web_sources.id
    createdAt: text('created_at').notNull().default(now),
  },
  (table) => [index('idx_nearby_places_lot').on(table.parkingLotId)],
)
