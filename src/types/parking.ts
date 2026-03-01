export interface ParkingLot {
  id: string               // 주차장관리번호
  name: string             // 주차장명
  type: string             // 노상/노외/부설
  address: string          // 도로명주소
  lat: number
  lng: number
  totalSpaces: number      // 총 주차면수
  freeSpaces?: number      // 무료 주차구획수
  operatingHours: {        // 운영시간
    weekday: { start: string; end: string }
    saturday: { start: string; end: string }
    holiday: { start: string; end: string }
  }
  pricing: {               // 요금정보
    isFree: boolean
    baseTime: number       // 기본시간(분)
    baseFee: number        // 기본요금(원)
    extraTime: number      // 추가단위시간(분)
    extraFee: number       // 추가단위요금(원)
    dailyMax?: number      // 1일 최대요금
    monthlyPass?: number   // 월정기권
  }
  difficulty: {            // 난이도 (자동추론 + 사용자평가)
    score: number          // 1.0-5.0
    entryScore?: number    // 진입로
    spaceScore?: number    // 주차면 크기
    passageScore?: number  // 통로 여유
    exitScore?: number     // 출차 난이도
    reviewCount: number    // 리뷰 수
  }
  phone?: string
  paymentMethods?: string
  notes?: string           // 특기사항
}

export interface MapBounds {
  south: number
  north: number
  west: number
  east: number
}
