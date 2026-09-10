import type { FieldSource } from '@/lib/lot-field-groups'

/**
 * 제보 행의 상태.
 *
 *  applied     화면에 반영 중 — 원본이 비어 있어서 즉시 반영됐다. 「유저제보」 배지가 붙는다
 *  pending     승인 대기 — 원본에 값이 있거나 이미 verified 라 바로 반영하지 않는다
 *  verified    관리자가 확인함. 배지 없이 원본과 같은 무게로 그린다
 *  rejected    관리자 반려
 *  superseded  다른 유저가 덮어씀
 */
export type EditStatus = 'applied' | 'pending' | 'verified' | 'rejected' | 'superseded'

/** 화면에 서는 상태 — 그룹당 최대 하나 (부분 유니크 인덱스가 강제한다) */
export const ACTIVE_STATUSES: readonly EditStatus[] = ['applied', 'verified'] as const

export interface TransitionInput {
  /** 지금 이 그룹에 서 있는 제보의 상태. 없으면 null */
  activeStatus: 'applied' | 'verified' | null
  /** 제보가 없을 때, 원본(parking_lots)이 비어 있나 */
  baseIsEmpty: boolean
}

export interface TransitionResult {
  /** 새로 넣을 행의 상태 */
  nextStatus: 'applied' | 'pending'
  /** 서 있던 행을 superseded 로 내려야 하나 */
  supersedeActive: boolean
  /** 제출 시점에 값이 있었나 — 감사용으로 행에 남긴다 */
  baseHadValue: boolean
}

/**
 * A안: **비어 있을 때만 즉시 반영**한다.
 *
 * 값이 이미 있으면(원본이든 관리자가 확인한 제보든) 승인 큐로 보낸다. 원본 값 대부분은
 * 공공데이터·운영사에서 온 것이고 sync 가 주기적으로 다시 덮으므로, 즉시 반영을 허용해도
 * 다음 동기화에서 되돌아가 유저가 "고쳐도 안 바뀐다"를 겪는다.
 *
 * 예외는 이미 `applied` 인 칸이다 — 유저가 채운 값은 다른 유저가 바로 고칠 수 있어야
 * 위키처럼 굴러간다. 관리자가 pick 하는 순간 그 문은 닫힌다.
 */
export function resolveTransition({
  activeStatus,
  baseIsEmpty,
}: TransitionInput): TransitionResult {
  if (activeStatus === 'verified') {
    return { nextStatus: 'pending', supersedeActive: false, baseHadValue: true }
  }
  if (activeStatus === 'applied') {
    return { nextStatus: 'applied', supersedeActive: true, baseHadValue: true }
  }
  return {
    nextStatus: baseIsEmpty ? 'applied' : 'pending',
    supersedeActive: false,
    baseHadValue: !baseIsEmpty,
  }
}

/** 화면에 서 있는 상태 → 값의 출처 */
export function statusToFieldSource(status: 'applied' | 'verified'): FieldSource {
  return status === 'verified' ? 'verified' : 'user'
}

/** 같은 IP 가 같은 칸을 연달아 뒤집는 걸 막는 간격 */
export const SAME_IP_COOLDOWN_MS = 10 * 60 * 1000
