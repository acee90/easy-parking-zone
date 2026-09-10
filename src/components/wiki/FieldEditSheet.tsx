import { useState } from 'react'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import {
  CANONICAL_24H,
  FIELD_GROUP_LABELS,
  type FieldGroup,
  isFieldGroupEmpty,
} from '@/lib/lot-field-groups'
import { formatOperatingHours, formatPricing, is24HourRange } from '@/lib/parking-display'
import { estimateFee } from '@/lib/parking-fee'
import { submitFieldEdit } from '@/server/field-edits'
import type { ParkingLot } from '@/types/parking'

/**
 * 기본정보 제보 폼.
 *
 * 한 번에 **한 그룹만** 받는다. 세 그룹을 한 화면에 늘어놓으면 폼이 길어지고,
 * 실제로 아는 건 보통 하나다(요금표만 봤거나, 문 닫는 시간만 알거나).
 *
 * 제출 전에 **지금 값**과 **바로 반영되는지**를 먼저 말한다 — 다 적고 난 뒤에
 * "관리자 확인 후 반영됩니다"를 보면 속은 기분이 든다.
 */
export function FieldEditSheet({
  lot,
  group,
  open,
  onOpenChange,
  onSubmitted,
}: {
  lot: ParkingLot
  group: FieldGroup | null
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 제보가 즉시 반영됐을 때(applied) 호출 — 화면을 다시 읽어 값을 세운다 */
  onSubmitted: (status: 'applied' | 'pending') => void
}) {
  if (!group) return null
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[92vh] overflow-y-auto">
        <FieldEditForm
          key={group}
          lot={lot}
          group={group}
          onDone={(status) => {
            onOpenChange(false)
            onSubmitted(status)
          }}
        />
      </SheetContent>
    </Sheet>
  )
}

/** 지금 화면에 서 있는 값 — 무엇을 덮어쓰는지 보여준다 */
function currentValueText(lot: ParkingLot, group: FieldGroup): string {
  if (group === 'spaces')
    return lot.totalSpaces > 0 ? `${lot.totalSpaces.toLocaleString()}면` : '정보 없음'
  if (group === 'hours') {
    const h = formatOperatingHours(lot.operatingHours)
    return h.isUnknown ? '정보 없음' : h.primary
  }
  const p = formatPricing(lot.pricing)
  return p.isUnknown ? '정보 없음' : p.primary
}

function FieldEditForm({
  lot,
  group,
  onDone,
}: {
  lot: ParkingLot
  group: FieldGroup
  onDone: (status: 'applied' | 'pending') => void
}) {
  const isEmpty = isFieldGroupEmpty(lot, group)
  const [payload, setPayload] = useState<Record<string, unknown>>(() => initialPayload(lot, group))
  const [sourceNote, setSourceNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      const res = await submitFieldEdit({
        data: {
          parkingLotId: lot.id,
          fieldGroup: group,
          payload: toSubmitPayload(group, payload),
          sourceNote: sourceNote.trim() || undefined,
        },
      })
      onDone(res.status)
    } catch (err) {
      setError(err instanceof Error ? err.message : '제보에 실패했습니다')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 pb-2">
      <SheetHeader className="gap-1 px-0">
        <SheetTitle className="text-[18px]">{FIELD_GROUP_LABELS[group]} 제보</SheetTitle>
        <SheetDescription className="text-[12.5px]">
          현재: <span className="font-semibold text-ink-2">{currentValueText(lot, group)}</span>
        </SheetDescription>
      </SheetHeader>

      {/* 반영 방식을 **먼저** 말한다 */}
      <p
        className={`rounded-lg px-3 py-2 text-[12px] leading-relaxed ${
          isEmpty ? 'bg-good-tint text-good' : 'bg-hair-2 text-ink-2'
        }`}
      >
        {isEmpty
          ? '비어 있는 정보라 바로 반영됩니다. 「유저제보」 표시가 붙어요.'
          : '이미 값이 있어 바로 반영되지 않습니다. 관리자 확인 후 반영돼요.'}
      </p>

      {group === 'fee' && <FeeFields payload={payload} setPayload={setPayload} />}
      {group === 'hours' && <HoursFields payload={payload} setPayload={setPayload} />}
      {group === 'spaces' && <SpacesFields payload={payload} setPayload={setPayload} />}

      <label className="flex flex-col gap-1.5">
        <span className="text-[12px] font-semibold text-ink-2">어떻게 아셨나요? (선택)</span>
        <input
          type="text"
          value={sourceNote}
          maxLength={200}
          onChange={(e) => setSourceNote(e.target.value)}
          placeholder="현장 요금표에서 확인했어요"
          className="rounded-lg border border-zinc-200 px-3 py-2 text-[14px] outline-none focus:border-zinc-400"
        />
      </label>

      {error && <p className="text-[12.5px] font-semibold text-risk">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="rounded-lg bg-primary px-4 py-3 text-[15px] font-bold text-primary-foreground disabled:opacity-50"
      >
        {busy ? '보내는 중…' : '제보하기'}
      </button>
      <p className="text-[11px] leading-relaxed text-faint">
        로그인하면 제보 이력이 남아요. 잘못된 정보는 관리자가 되돌립니다.
      </p>
    </form>
  )
}

// ── 그룹별 입력 ───────────────────────────────────────────────

const inputClass =
  'w-full rounded-lg border border-zinc-200 px-3 py-2 text-[15px] tabular-nums outline-none focus:border-zinc-400'

type FieldsProps = {
  payload: Record<string, unknown>
  setPayload: React.Dispatch<React.SetStateAction<Record<string, unknown>>>
}

function NumberField({
  label,
  value,
  onChange,
  suffix,
  placeholder,
}: {
  label: string
  value: unknown
  onChange: (v: string) => void
  suffix: string
  placeholder?: string
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[12px] font-semibold text-ink-2">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="number"
          inputMode="numeric"
          min={0}
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className={inputClass}
        />
        <span className="shrink-0 text-[13px] text-muted-foreground">{suffix}</span>
      </div>
    </label>
  )
}

function FeeFields({ payload, setPayload }: FieldsProps) {
  const isFree = payload.isFree === true
  const set = (k: string) => (v: string) =>
    setPayload((p) => ({ ...p, [k]: v === '' ? null : Number(v) }))

  // 자릿수를 잘못 적은 걸 바로 알아채도록 1시간 예상 요금을 같이 그린다 (20,000 vs 2,000)
  const preview = isFree
    ? null
    : estimateFee(
        {
          isFree: false,
          baseTime: Number(payload.baseTime) || 0,
          baseFee: Number(payload.baseFee) || 0,
          extraTime: Number(payload.extraTime) || 0,
          extraFee: Number(payload.extraFee) || 0,
          dailyMax: payload.dailyMax == null ? undefined : Number(payload.dailyMax),
        },
        60,
      )

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {[
          { value: false, label: '유료' },
          { value: true, label: '무료' },
        ].map((opt) => (
          <button
            key={String(opt.value)}
            type="button"
            aria-pressed={isFree === opt.value}
            onClick={() => setPayload((p) => ({ ...p, isFree: opt.value }))}
            className={`flex-1 rounded-lg px-4 py-2.5 text-[14px] font-bold transition-colors ${
              isFree === opt.value
                ? 'bg-primary text-primary-foreground'
                : 'bg-zinc-100 text-zinc-700'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {!isFree && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="기본 시간"
              value={payload.baseTime}
              onChange={set('baseTime')}
              suffix="분"
              placeholder="30"
            />
            <NumberField
              label="기본 요금"
              value={payload.baseFee}
              onChange={set('baseFee')}
              suffix="원"
              placeholder="1000"
            />
            <NumberField
              label="추가 시간"
              value={payload.extraTime}
              onChange={set('extraTime')}
              suffix="분"
              placeholder="10"
            />
            <NumberField
              label="추가 요금"
              value={payload.extraFee}
              onChange={set('extraFee')}
              suffix="원"
              placeholder="500"
            />
          </div>
          <NumberField
            label="1일 최대 요금 (선택)"
            value={payload.dailyMax}
            onChange={set('dailyMax')}
            suffix="원"
            placeholder="비워 두면 상한 없음"
          />
          {preview !== null && (
            <p className="text-[12.5px] tabular-nums text-muted-foreground">
              1시간 예상 <span className="font-bold text-ink">{preview.toLocaleString()}원</span>
            </p>
          )}
        </>
      )}
    </div>
  )
}

function TimeRow({
  label,
  start,
  end,
  onChange,
}: {
  label: string
  start: string
  end: string
  onChange: (next: { start: string; end: string }) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[12px] font-semibold text-ink-2">{label}</span>
      {/* 모바일 기본 시간 선택기를 그대로 쓴다 — 직접 만든 위젯보다 실수가 적다 */}
      <input
        type="time"
        value={start}
        onChange={(e) => onChange({ start: e.target.value, end })}
        className={inputClass}
      />
      <span className="text-muted-foreground">–</span>
      <input
        type="time"
        value={end}
        onChange={(e) => onChange({ start, end: e.target.value })}
        className={inputClass}
      />
    </div>
  )
}

function HoursFields({ payload, setPayload }: FieldsProps) {
  const all24 = payload.all24 === true
  const sameAsWeekday = payload.sameAsWeekday !== false
  const weekday = (payload.weekday as { start: string; end: string }) ?? { start: '', end: '' }
  const saturday = (payload.saturday as { start: string; end: string }) ?? { start: '', end: '' }
  const holiday = (payload.holiday as { start: string; end: string }) ?? { start: '', end: '' }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2.5">
        <input
          type="checkbox"
          checked={all24}
          onChange={(e) => setPayload((p) => ({ ...p, all24: e.target.checked }))}
          className="size-4"
        />
        <span className="text-[14px] font-semibold text-ink">24시간 운영</span>
      </label>

      {!all24 && (
        <>
          <TimeRow
            label="평일"
            start={weekday.start}
            end={weekday.end}
            onChange={(next) => setPayload((p) => ({ ...p, weekday: next }))}
          />
          <label className="flex items-center gap-2.5">
            <input
              type="checkbox"
              checked={sameAsWeekday}
              onChange={(e) => setPayload((p) => ({ ...p, sameAsWeekday: e.target.checked }))}
              className="size-4"
            />
            <span className="text-[13px] text-ink-2">토·공휴일도 같아요</span>
          </label>
          {!sameAsWeekday && (
            <>
              <TimeRow
                label="토요일"
                start={saturday.start}
                end={saturday.end}
                onChange={(next) => setPayload((p) => ({ ...p, saturday: next }))}
              />
              <TimeRow
                label="공휴일"
                start={holiday.start}
                end={holiday.end}
                onChange={(next) => setPayload((p) => ({ ...p, holiday: next }))}
              />
            </>
          )}
        </>
      )}
    </div>
  )
}

function SpacesFields({ payload, setPayload }: FieldsProps) {
  return (
    <NumberField
      label="총 주차면 수"
      value={payload.totalSpaces}
      onChange={(v) => setPayload((p) => ({ ...p, totalSpaces: v === '' ? null : Number(v) }))}
      suffix="면"
      placeholder="120"
    />
  )
}

// ── 폼 상태 ↔ 서버 payload ────────────────────────────────────

/** 값이 이미 있으면 그 값에서 시작한다 — 고치러 온 사람이 다시 다 적을 이유가 없다 */
function initialPayload(lot: ParkingLot, group: FieldGroup): Record<string, unknown> {
  if (group === 'spaces') {
    return { totalSpaces: lot.totalSpaces > 0 ? lot.totalSpaces : null }
  }
  if (group === 'hours') {
    const { weekday, saturday, holiday } = lot.operatingHours
    const all24 = is24HourRange(weekday)
    const pick = (r: { start: string; end: string }) =>
      /^\d{1,2}:\d{2}$/.test(r.start ?? '') && !is24HourRange(r) ? r : { start: '', end: '' }
    const wd = pick(weekday)
    return {
      all24,
      sameAsWeekday:
        saturday.start === weekday.start &&
        saturday.end === weekday.end &&
        holiday.start === weekday.start &&
        holiday.end === weekday.end,
      weekday: wd,
      saturday: pick(saturday),
      holiday: pick(holiday),
    }
  }
  const { isFree, baseTime, baseFee, extraTime, extraFee, dailyMax } = lot.pricing
  return {
    isFree,
    baseTime: baseTime > 0 ? baseTime : null,
    baseFee: baseFee > 0 ? baseFee : null,
    extraTime: extraTime > 0 ? extraTime : null,
    extraFee: extraFee > 0 ? extraFee : null,
    dailyMax: dailyMax && dailyMax > 0 ? dailyMax : null,
  }
}

/** 폼 상태를 서버가 검증할 모양으로. 24시간 토글은 여기서 표준 표기로 바뀐다 */
export function toSubmitPayload(group: FieldGroup, form: Record<string, unknown>): unknown {
  if (group === 'spaces') return { totalSpaces: Number(form.totalSpaces) }
  if (group === 'hours') {
    if (form.all24 === true) {
      return { weekday: CANONICAL_24H, saturday: CANONICAL_24H, holiday: CANONICAL_24H }
    }
    const weekday = form.weekday as { start: string; end: string }
    if (form.sameAsWeekday !== false) return { weekday }
    return { weekday, saturday: form.saturday, holiday: form.holiday }
  }
  if (form.isFree === true) return { isFree: true }
  return {
    isFree: false,
    baseTime: Number(form.baseTime),
    baseFee: Number(form.baseFee ?? 0),
    extraTime: Number(form.extraTime ?? 0),
    extraFee: Number(form.extraFee ?? 0),
    dailyMax: form.dailyMax ?? null,
  }
}
