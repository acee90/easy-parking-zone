import { sql } from 'drizzle-orm'
import { getDb } from '@/db'
import {
  applyFieldEdit,
  DEFAULT_FIELD_SOURCES,
  type FieldSources,
  isFieldGroup,
  parseFieldPayload,
} from '@/lib/lot-field-groups'
import { statusToFieldSource } from '@/lib/lot-field-transitions'
import type { ParkingLot } from '@/types/parking'

interface ActiveEditRow {
  id: number
  field_group: string
  payload: string
  status: string
}

/**
 * 한 주차장의 활성 제보(applied·verified)를 읽어 원본 위에 얹는다.
 *
 * 테이블이 아직 없는 환경(마이그레이션 전 로컬)에서도 상세페이지가 죽으면 안 된다 —
 * `fetchDestinationsForLot` 과 같은 이유로 실패를 삼키고 원본을 그대로 돌려준다.
 */
export async function mergeFieldEdits(
  lot: ParkingLot,
): Promise<{ lot: ParkingLot; fieldSources: FieldSources }> {
  const fieldSources: FieldSources = { ...DEFAULT_FIELD_SOURCES }
  let merged = lot

  try {
    const db = getDb()
    const rows = (await db.all(
      sql`SELECT id, field_group, payload, status
          FROM lot_field_edits
          WHERE parking_lot_id = ${lot.id}
            AND status IN ('applied', 'verified')`,
    )) as unknown as ActiveEditRow[]

    for (const row of rows) {
      if (!isFieldGroup(row.field_group)) continue
      const payload = parseFieldPayload(row.field_group, row.payload)
      if (!payload) continue
      merged = applyFieldEdit(merged, row.field_group, payload)
      fieldSources[row.field_group] = statusToFieldSource(
        row.status === 'verified' ? 'verified' : 'applied',
      )
    }
  } catch {
    return { lot, fieldSources }
  }

  return { lot: merged, fieldSources }
}
