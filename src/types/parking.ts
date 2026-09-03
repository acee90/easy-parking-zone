export interface ParkingLot {
  id: string // 주차장관리번호
  name: string // 주차장명
  type: string // 노상/노외/부설
  address: string // 도로명주소
  lat: number
  lng: number
  totalSpaces: number // 총 주차면수
  freeSpaces?: number // 무료 주차구획수
  operatingHours: {
    // 운영시간
    weekday: { start: string; end: string }
    saturday: { start: string; end: string }
    holiday: { start: string; end: string }
  }
  pricing: {
    // 요금정보
    isFree: boolean
    baseTime: number // 기본시간(분)
    baseFee: number // 기본요금(원)
    extraTime: number // 추가단위시간(분)
    extraFee: number // 추가단위요금(원)
    dailyMax?: number // 1일 최대요금
    monthlyPass?: number // 월정기권
  }
  difficulty: {
    // 난이도 (통합 점수)
    score: number | null // 1.0-5.0, null이면 데이터 없음
    entryScore?: number // 진입로
    spaceScore?: number // 주차면 크기
    passageScore?: number // 통로 여유
    exitScore?: number // 출차 난이도
    reviewCount: number // 리뷰 수
    reliability?: 'confirmed' | 'estimated' | 'reference' | 'structural' | 'none'
  }
  phone?: string
  paymentMethods?: string
  notes?: string // 특기사항
  poiTags?: string[] // POI 태그 (e.g. ['서울역', '용산역'])
  curationTag?: 'hell' | 'easy' | null // 큐레이션 태그
  curationReason?: string // 큐레이션 사유
  featuredSource?: string // 출처 (e.g. '1010' = 10시10분 채널)
  verifiedSource?: string // 검증 출처 ('public_api' | 'kakao_detail' | 'naver_detail')
  aiSummary?: string // AI가 블로그/리뷰를 정리한 한 줄 요약
  aiSummaryUpdatedAt?: string
  aiTipPricing?: string // 요금/할인 팁
  aiTipVisit?: string // 방문/난이도 팁
  aiTipAlternative?: string // 대안/주변 연계 팁
}

export interface Place {
  name: string
  address: string
  lat: number
  lng: number
  category?: string
}

export interface MapBounds {
  south: number
  north: number
  west: number
  east: number
}

export interface BlogPost {
  id: number
  title: string
  snippet: string // 네이버 검색 스니펫 (원문 일부)
  summary?: string // AI 가공 요약 (있을 때 snippet 대신 사용)
  sourceUrl: string
  source: 'naver_blog' | 'naver_cafe' | 'youtube_comment' | 'google_search' | 'clien'
  author: string
  publishedAt?: string
  relevanceScore?: number
}

export interface ParkingMedia {
  id: number
  mediaType: 'youtube' | 'image' | 'streetview'
  url: string
  title?: string
  thumbnailUrl?: string
  description?: string
}

export interface NearbyPlaceInfo {
  id: number
  name: string
  category: 'cafe' | 'restaurant' | 'park' | 'tourist' | 'market' | 'hospital' | 'etc'
  tip?: string
  mentionCount: number
  thumbnailUrl?: string
}

export interface DifficultyFilter {
  easy: boolean // 😊 초보추천 (4.0-5.0)
  decent: boolean // 🙂 무난 (3.3-3.9)
  normal: boolean // 😐 보통 (2.7-3.2)
  bad: boolean // 😕 별로 (2.0-2.6)
  hard: boolean // 💀 비추 (1.5-1.9)
  hell: boolean // 🔥 헬 (1.0-1.4)
}

/** 1시간 기준 요금 상한 필터. 'any' = 전체 */
export type FeeRange = 'any' | '3000' | '5000' | '10000'

export interface ParkingFilters {
  freeOnly: boolean
  publicOnly: boolean // 공영(공공데이터 출처)만
  excludeNoSang: boolean // 노상 제외
  difficulty: DifficultyFilter
  feeRange: FeeRange // 1시간 기준 요금 상한
  openNow: boolean // 현재 운영중인 주차장만
  minSpaces: number | null // 최소 주차면 수 (null = 제한 없음)
}

export const DEFAULT_DIFFICULTY: DifficultyFilter = {
  easy: true,
  decent: true,
  normal: true,
  bad: true,
  hard: true,
  hell: true,
}

export const DEFAULT_FILTERS: ParkingFilters = {
  freeOnly: false,
  publicOnly: false,
  excludeNoSang: false,
  difficulty: { ...DEFAULT_DIFFICULTY },
  feeRange: 'any',
  openNow: false,
  minSpaces: null,
}

export type SortMode = 'distance' | 'difficulty'

export interface UserReview {
  id: number
  author: {
    type: 'member' | 'guest'
    nickname: string
    profileImage?: string
  }
  scores: {
    entry: number
    space: number
    passage: number
    exit: number
    overall: number
  }
  comment?: string
  visitedAt?: string
  createdAt: string
  isMine: boolean
  sourceType?: string // 'clien' 등 외부 커뮤니티 출처
  sourceUrl?: string // 원본 URL
}

// ============================================================
// 목적지 축 페이지 (#166) — /near/{목적지}
// ============================================================

export interface Destination {
  id: string // 'D-0001'
  name: string
  slug: string
  category: 'station' | 'market' | 'mall' | 'tourist'
  lat: number
  lng: number
  address?: string
  lotCount: number
  freeCount: number
  publishedAt: string
  /** 'public_data:15013205' | 'osm:overpass' … 좌표 출처. osm 이면 ODbL 표기가 필요하다 */
  source: string
}

/** 목적지에 연결된 주차장 한 줄. ParkingLot 에 목적지 기준 거리를 얹은 것 */
export interface DestinationLot {
  lot: ParkingLot
  distanceM: number
  walkMinutes: number // 직선거리 기준
  rank: number
  evidenceSourceId: number | null
}

/** 주차장 상세페이지의 "이 주차장으로 갈 수 있는 곳" 한 줄 */
export interface DestinationLink {
  id: string
  name: string
  slug: string
  category: Destination['category']
  distanceM: number
}

/** 목적지 목록 페이지(/near)와 검색 자동완성 한 줄 */
export interface DestinationSummary {
  id: string
  name: string
  slug: string
  category: Destination['category']
  lotCount: number
  freeCount: number
  /** 가장 가까운 주차장 주소로 판정한 지역 라벨(서울, 경기 …). 판정 불가면 null */
  region: string | null
}
