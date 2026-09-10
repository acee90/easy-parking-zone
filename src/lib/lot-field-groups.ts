import { isUnsetTimeRange } from '@/lib/parking-display'
import { estimateFee } from '@/lib/parking-fee'
import type { ParkingLot } from '@/types/parking'

/**
 * 유저 제보의 단위.
 *
 * 컬럼 하나가 아니라 **묶음**이다. `is_free` 와 `base_fee` 를 따로 받으면
 * "무료인데 시간당 2,000원" 같은 모순된 조합이 만들어진다.
 */
export type FieldGroup = 'fee' | 'hours' | 'spaces'

export const FIELD_GROUPS: readonly FieldGroup[] = ['fee', 'hours', 'spaces'] as const

export const FIELD_GROUP_LABELS: Record<FieldGroup, string> = {
  fee: '주차 요금',
  hours: '운영 시간',
  spaces: '주차면',
}

/** 이 값이 화면에 서 있는 근거 */
export type FieldSource = 'official' | 'user' | 'verified'

export type FieldSources = Record<FieldGroup, FieldSource>

export const DEFAULT_FIELD_SOURCES: FieldSources = {
  fee: 'official',
  hours: 'official',
  spaces: 'official',
}

// ── payload ──────────────────────────────────────────────────

export interface FeePayload {
  isFree: boolean
  baseTime: number
  baseFee: number
  extraTime: number
  extraFee: number
  dailyMax: number | null
}

export interface TimeRangeInput {
  start: string
  end: string
}

export interface HoursPayload {
  weekday: TimeRangeInput
  saturday: TimeRangeInput
  holiday: TimeRangeInput
}

export interface SpacesPayload {
  totalSpaces: number
}

export type FieldPayload = FeePayload | HoursPayload | SpacesPayload

/**
 * 24시간 운영의 저장 표기.
 *
 * 출처마다 `00:00-23:59`·`00:00-24:00` 로 갈리는데(→ `parking-display.ts`),
 * 우리가 새로 쓰는 값은 하나로 고정한다. 읽는 쪽은 둘 다 24시간으로 본다.
 */
export const CANONICAL_24H: TimeRangeInput = { start: '00:00', end: '24:00' }

// ── 비어 있음 판정 ────────────────────────────────────────────

/**
 * 이 그룹이 「정보 없음」인가.
 *
 * ⚠️ 히어로 KPI 칸이 「정보 없음」을 그리는 조건과 **같아야 한다**. 둘이 어긋나면
 * 유저가 빈 칸을 눌러 제보했는데 "관리자 확인 후 반영됩니다" 가 뜨는 꼴이 된다.
 * `LotHeroSection.buildKpis` 와 이 함수는 같은 규칙을 공유한다.
 */
export function isFieldGroupEmpty(lot: ParkingLot, group: FieldGroup): boolean {
  switch (group) {
    case 'fee': {
      // 무료는 그 자체로 아는 값이다. 유료인데 시간당 요금도 1일 최대도 모르면 미상
      if (lot.pricing.isFree) return false
      if (estimateFee(lot.pricing, 60) !== null) return false
      return !(lot.pricing.dailyMax && lot.pricing.dailyMax > 0)
    }
    case 'hours':
      return (
        isUnsetTimeRange(lot.operatingHours.weekday) &&
        isUnsetTimeRange(lot.operatingHours.saturday) &&
        isUnsetTimeRange(lot.operatingHours.holiday)
      )
    case 'spaces':
      return lot.totalSpaces <= 0
  }
}

// ── 검증 ─────────────────────────────────────────────────────

/** 24시간을 넘겨 적는 실수를 막는 상한. 1일 최대 요금은 이보다 크게 잡을 이유가 없다 */
const MAX_FEE = 500_000
const MAX_MINUTES = 1440
const MAX_SPACES = 100_000

function assertMoney(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0 || value > MAX_FEE) {
    throw new Error(`${label} 값을 확인해 주세요`)
  }
  return value
}

function assertMinutes(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0 || value > MAX_MINUTES) {
    throw new Error(`${label}은 1~1440분 사이여야 합니다`)
  }
  return value
}

const TIME_RE = /^([01]\d|2[0-4]):([0-5]\d)$/

function parseTimeRange(range: unknown, label: string): TimeRangeInput {
  const r = range as TimeRangeInput | undefined
  const start = typeof r?.start === 'string' ? r.start.trim() : ''
  const end = typeof r?.end === 'string' ? r.end.trim() : ''
  if (!TIME_RE.test(start) || !TIME_RE.test(end)) {
    throw new Error(`${label} 시각 형식이 올바르지 않습니다`)
  }
  // 시작과 끝이 같으면 "안 연다"인지 "24시간"인지 알 수 없다 — 24시간은 토글로 받는다
  if (start === end) throw new Error(`${label} 시작과 종료가 같습니다`)
  return { start, end }
}

/**
 * 제출된 payload 를 신뢰할 수 있는 형태로 좁힌다.
 * 클라이언트를 믿지 않는다 — 서버가 이 함수를 통과한 값만 저장한다.
 */
export function validateFieldPayload(group: FieldGroup, raw: unknown): FieldPayload {
  if (!raw || typeof raw !== 'object') throw new Error('입력값이 없습니다')
  const input = raw as Record<string, unknown>

  if (group === 'spaces') {
    const totalSpaces = Number(input.totalSpaces)
    if (
      !Number.isFinite(totalSpaces) ||
      !Number.isInteger(totalSpaces) ||
      totalSpaces <= 0 ||
      totalSpaces > MAX_SPACES
    ) {
      throw new Error('주차면 수를 확인해 주세요')
    }
    return { totalSpaces }
  }

  if (group === 'hours') {
    const weekday = parseTimeRange(input.weekday, '평일')
    // 토·공휴일을 안 보내면 평일과 같다고 본다 (폼의 「토·공휴일 동일」 기본값)
    const saturday = input.saturday ? parseTimeRange(input.saturday, '토요일') : weekday
    const holiday = input.holiday ? parseTimeRange(input.holiday, '공휴일') : weekday
    return { weekday, saturday, holiday }
  }

  const isFree = input.isFree === true
  if (isFree) {
    return { isFree: true, baseTime: 0, baseFee: 0, extraTime: 0, extraFee: 0, dailyMax: null }
  }

  const baseTime = assertMinutes(Number(input.baseTime), '기본 시간')
  const baseFee = assertMoney(Number(input.baseFee), '기본 요금')

  // 추가 요금은 선택 — 정액제(기본시간이 하루)는 추가 요금이 없다
  const hasExtra = Number(input.extraTime) > 0 || Number(input.extraFee) > 0
  const extraTime = hasExtra ? assertMinutes(Number(input.extraTime), '추가 시간') : 0
  const extraFee = hasExtra ? assertMoney(Number(input.extraFee), '추가 요금') : 0

  const rawDaily = input.dailyMax
  const dailyMax =
    rawDaily === null || rawDaily === undefined || rawDaily === ''
      ? null
      : assertMoney(Number(rawDaily), '1일 최대 요금')

  if (baseFee === 0 && extraFee === 0 && dailyMax === null) {
    throw new Error('유료 주차장이면 요금을 하나 이상 적어 주세요')
  }
  if (dailyMax !== null && dailyMax > 0 && baseFee > dailyMax) {
    throw new Error('1일 최대 요금이 기본 요금보다 적습니다')
  }

  return { isFree: false, baseTime, baseFee, extraTime, extraFee, dailyMax }
}

// ── 병합 ─────────────────────────────────────────────────────

/** 제보 payload 를 원본 lot 위에 얹는다. 원본을 바꾸지 않고 새 객체를 돌려준다 */
export function applyFieldEdit(
  lot: ParkingLot,
  group: FieldGroup,
  payload: FieldPayload,
): ParkingLot {
  switch (group) {
    case 'fee': {
      const p = payload as FeePayload
      return { ...lot, pricing: { ...lot.pricing, ...p, dailyMax: p.dailyMax ?? undefined } }
    }
    case 'hours': {
      const p = payload as HoursPayload
      return { ...lot, operatingHours: { ...p } }
    }
    case 'spaces': {
      const p = payload as SpacesPayload
      return { ...lot, totalSpaces: p.totalSpaces }
    }
  }
}

/** 그룹을 「모름」 상태로 되돌린 값 — 검색엔진에 내보내지 않을 때 쓴다 */
const EMPTY_GROUP: Record<FieldGroup, FieldPayload> = {
  fee: { isFree: false, baseTime: 0, baseFee: 0, extraTime: 0, extraFee: 0, dailyMax: null },
  hours: {
    weekday: { start: '', end: '' },
    saturday: { start: '', end: '' },
    holiday: { start: '', end: '' },
  },
  spaces: { totalSpaces: 0 },
}

/**
 * 관리자가 확인하지 않은 제보값(`user`)을 걷어낸다.
 *
 * 구조화 데이터(JSON-LD)와 색인 판정에 쓴다. 화면에는 「유저제보」 배지를 달아 근거를
 * 밝히고 보여주지만, 검색엔진에는 그 표시가 함께 나가지 않는다 — 같은 값이 구글에서는
 * 확정 사실처럼 읽히기 때문이다. `verified` 는 관리자가 확인했으므로 그대로 둔다.
 */
export function stripUnverifiedEdits(lot: ParkingLot, sources: FieldSources): ParkingLot {
  let out = lot
  for (const group of FIELD_GROUPS) {
    if (sources[group] === 'user') out = applyFieldEdit(out, group, EMPTY_GROUP[group])
  }
  return out
}

/** 저장된 JSON 문자열을 payload 로. 깨진 행 하나가 상세페이지를 죽이면 안 된다 */
export function parseFieldPayload(group: FieldGroup, json: string): FieldPayload | null {
  try {
    return validateFieldPayload(group, JSON.parse(json))
  } catch {
    return null
  }
}

export function isFieldGroup(value: unknown): value is FieldGroup {
  return typeof value === 'string' && (FIELD_GROUPS as readonly string[]).includes(value)
}
