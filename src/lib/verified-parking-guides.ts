import { estimateFee } from '@/lib/parking-fee'
import { makeParkingSlug } from '@/lib/slug'
import type { ParkingLot } from '@/types/parking'

export interface VerifiedParkingGuide {
  id: string
  name: string
  checkedAt: string
  source: { label: string; url: string }
  summary: string
  pricing: ParkingLot['pricing']
  freeExitMinutes?: number
  decisions: { title: string; text: string }[]
}

// 고정된 5곳만 검증한다. 확인일은 재검토할 때만 갱신하며 방문 경험을 주장하지 않는다.
export const VERIFIED_PARKING_GUIDES: VerifiedParkingGuide[] = [
  {
    id: 'KA-1935812519',
    name: '스타필드시티 위례 주차장',
    checkedAt: '2026-09-18',
    source: {
      label: '스타필드 시티 위례 공식 주차 안내',
      url: 'https://www.starfield.co.kr/wirye/about/parkingInfo.do',
    },
    summary: '주차요금 무료. 트레이더스 방문이면 지하주차장으로 진입하세요.',
    pricing: { isFree: true, baseTime: 0, baseFee: 0, extraTime: 0, extraFee: 0 },
    decisions: [
      {
        title: '입구에서 목적지에 맞게 선택',
        text: '공식 안내의 동측 진입로는 지상·지하 주차장으로 이어집니다. 트레이더스는 B3에 있고 지하주차장 이용을 안내하고 있어, 장보기 목적이면 지하 방향을 먼저 확인하세요.',
      },
      {
        title: '식사·영화와 장보기 동선 구분',
        text: 'PK키친·다이소·노브랜드는 B1, 잇토피아는 4F, CGV는 5F로 안내됩니다. 여러 곳을 들를 때는 마지막 방문 매장과 짐을 차에 싣는 순서를 정한 뒤 주차 위치를 기록해 두세요.',
      },
      {
        title: '무료와 진입 편의는 별개',
        text: '무료 요금만으로 주차가 쉽거나 자리가 남았다고 판단할 수는 없습니다. 공식 페이지의 층별 주차현황을 확인하고, 차량 높이 제한은 현장 입구 표지로 확인하세요.',
      },
    ],
  },
  {
    id: 'KA-732776068',
    name: '스타필드 하남 주차장',
    checkedAt: '2026-09-18',
    source: {
      label: '스타필드 하남 공식 주차 안내',
      url: 'https://www.starfield.co.kr/hanam/about/parkingInfo.do',
    },
    summary: '주차요금 무료. 접근 방향과 트레이더스 이용 여부로 진입로를 고르세요.',
    pricing: { isFree: true, baseTime: 0, baseFee: 0, extraTime: 0, extraFee: 0 },
    decisions: [
      {
        title: '어느 방향에서 오는지 먼저 확인',
        text: '미사대로 쪽 동측 입구는 지하·지상, 하남IC 쪽 남측과 상일IC 쪽 서측 입구는 지하주차장으로 안내됩니다. 내비게이션 도착 직전에 차선을 바꾸기보다 접근 방향에 맞는 공식 진입 안내를 먼저 확인하세요.',
      },
      {
        title: '장보기라면 지하 방향',
        text: '트레이더스 이용객은 지하주차장을 이용하도록 안내합니다. 트레이더스·노브랜드는 B2, 고메스트리트·일렉트로마트는 1F에 있어 방문 매장에 따라 이동 층이 달라집니다.',
      },
      {
        title: '출차 전에 위치와 도로 상황 확인',
        text: '영수증, 몰 디렉토리·주차 정산기, 공식 앱에서 내 차 위치를 확인할 수 있습니다. 지하 웰컴홈의 외부 교통 안내를 보고 귀가 방향에 맞는 출구를 선택하세요. 이 페이지는 실시간 혼잡도를 제공하지 않습니다.',
      },
    ],
  },
  {
    id: 'KA-644595051',
    name: '스타필드 수원 주차장',
    checkedAt: '2026-09-18',
    source: {
      label: '스타필드 수원 공식 주차 안내',
      url: 'https://www.starfield.co.kr/suwon/about/parkingInfo.do',
    },
    summary: '6시간까지 무료, 이후 10분당 500원. 혼잡하면 대유평공원 연결통로를 확인하세요.',
    pricing: {
      isFree: false,
      baseTime: 360,
      baseFee: 0,
      extraTime: 10,
      extraFee: 500,
      dailyMax: 18000,
    },
    decisions: [
      {
        title: '6시간을 넘길 일정인지 계산',
        text: '공식 요금은 최초 6시간 무료, 이후 10분당 500원이며 1일 최대 18,000원입니다. 식사와 영화를 함께 할 때는 무료 종료 시각을 입차 시각 기준으로 계산해 두세요.',
      },
      {
        title: '본관이 혼잡할 때의 대안',
        text: '본관은 B3~B8, 대유평공원은 B1~B2 주차장을 안내합니다. 공원 B2에서 본관 B2로 보행 연결통로가 있어, 본관 진입 대기만 고집하기 전에 공식 주차현황을 확인할 수 있습니다.',
      },
      {
        title: '충전·귀가 방향까지 확인',
        text: '전기차 충전소는 본관 B3~B6에 있습니다. 공식 출구 안내는 1·4번을 영통·동탄, 2·3번을 호매실·광교·의왕 방면으로 구분합니다. 충전기 사용 가능 여부와 도로 정체는 별도로 확인해야 합니다.',
      },
    ],
  },
  {
    id: 'KA-27593534',
    name: '현대백화점 판교점 주차장',
    checkedAt: '2026-09-18',
    source: {
      label: '현대백화점 판교점 공식 위치·주차 안내',
      url: 'https://www.ehyundai.com/newPortal/DP/WC/WC000000_V.do?branchCd=B00148000',
    },
    summary:
      '최초 30분 무료, 초과 10분당 1,000원. 구매액별 무료 시간과 외부 주차장 조건을 구분하세요.',
    pricing: { isFree: false, baseTime: 30, baseFee: 0, extraTime: 10, extraFee: 1000 },
    decisions: [
      {
        title: '구매액에 맞는 무료 시간',
        text: '5만·10만·15만·20만원 이상 구매 시 각각 1·2·3·5시간을 안내합니다. 아래 표는 구매 할인을 적용하지 않은 요금이므로 할인 등록 후 실제 정산액을 확인하세요.',
      },
      {
        title: '쇼핑 외 방문도 할인 조건 확인',
        text: '현대어린이책미술관 관람은 2시간, 문화센터는 수강증 제시 시 강좌당 2시간 무료입니다. 교환·수선·환불은 B1 교환환불 데스크에서 무료주차권 수령 시 1시간을 안내합니다.',
      },
      {
        title: '주말 외부 주차장은 본관과 조건이 다름',
        text: '공식 안내는 토·일·공휴일 외부 임시 주차장으로 알파돔·테크원·그레이츠를 제시합니다. 이용 가능 시간과 구매액에 따른 정산 조건을 먼저 확인하세요. 주차관리실은 031-5170-3333입니다.',
      },
    ],
  },
  {
    id: 'KA-2056009871',
    name: 'IFC몰 주차장',
    checkedAt: '2026-09-18',
    source: { label: 'IFC MALL 공식 주차 안내', url: 'https://m.ifcmallseoul.com/kr/visit/park' },
    summary:
      '30분 이내 회차만 무료. 초과하면 최초 30분 3,000원도 부과되며 추가 10분당 1,000원입니다.',
    pricing: {
      isFree: false,
      baseTime: 30,
      baseFee: 3000,
      extraTime: 10,
      extraFee: 1000,
      dailyMax: 45000,
    },
    freeExitMinutes: 30,
    decisions: [
      {
        title: '31분부터는 무료 30분이 공제되지 않음',
        text: '30분 이내 출차만 무료 회차입니다. 넘기면 기본요금 3,000원에 추가 10분당 1,000원이 붙어, 할인 없이 1시간이면 6,000원입니다. 일 최대 45,000원은 0~24시 기준이며 자정을 넘기면 다음 날로 계산됩니다.',
      },
      {
        title: '할인은 매장에서 차량번호 등록',
        text: '구매액 2만·4만·6만·10만·15만원 이상에 각각 1·2·3·4·5시간 할인을 안내합니다. 영수증 금액 합산은 불가하며, 지하 무인정산소에서 영수증을 내는 방식이 아니라 해당 매장에서 차량번호를 등록해야 합니다. 할인 제외 매장도 확인하세요.',
      },
      {
        title: '차량 높이와 영화 할인 확인',
        text: '공식 안내는 높이 2.1m 이상 차량의 입출차·주차를 제한합니다. CGV는 주중 3시간 1,500원, 주말 3시간 무료로 안내합니다. 영화 할인 시간 초과분은 정산 전에 확인하세요.',
      },
    ],
  },
]

export function getVerifiedParkingGuide(id: string) {
  return VERIFIED_PARKING_GUIDES.find((guide) => guide.id === id)
}

export function verifiedGuidePath(guide: VerifiedParkingGuide) {
  return `/wiki/${encodeURI(makeParkingSlug(guide.name, guide.id))}`
}

/** 구매·영화 할인 없이, 같은 날 주차하는 경우. 무료 회차 후 기본요금 소급을 구분한다. */
export function estimateVerifiedFee(guide: VerifiedParkingGuide, minutes: number) {
  if (minutes <= 0 || !Number.isFinite(minutes)) return null
  if (guide.freeExitMinutes && minutes <= guide.freeExitMinutes) return 0
  return estimateFee(guide.pricing, minutes)
}
