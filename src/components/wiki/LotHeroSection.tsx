import { Flame, MapPin, Pencil, Plus, ThumbsUp } from 'lucide-react'
import { useState } from 'react'
import { FieldEditSheet } from '@/components/wiki/FieldEditSheet'
import { DividerCell, DividerGrid } from '@/components/wiki/SectionShell'
import { DEFAULT_FIELD_SOURCES, type FieldGroup, type FieldSources } from '@/lib/lot-field-groups'
import { formatTimeRange } from '@/lib/parking-display'
import { estimateFee } from '@/lib/parking-fee'
import type { ParkingLot } from '@/types/parking'

/** 1시간 기준으로 요금을 보여준다 — 사람들이 머릿속으로 잡는 단위 */
const ESTIMATE_MINUTES = 60

interface Kpi {
  key: string
  label: string
  value: string
  /** 값 뒤에 작게 붙는 단위 */
  unit?: string
  caption?: string
  /** 값이 없다는 뜻 — 숫자와 같은 무게로 그리지 않는다 */
  muted?: boolean
  /** 유저가 제보할 수 있는 칸이면 그 그룹. 「쉬움 점수」는 후기에서 나오므로 없다 */
  group?: FieldGroup
}

/** 하루 = 1,440분. 이 이상을 기본시간으로 잡은 곳은 시간제가 아니라 정액제다 */
const MINUTES_PER_DAY = 1440

/**
 * 분을 사람이 읽는 단위로. 1440분 → "24시간", 90분 → "1시간 30분", 30분 → "30분"
 *
 * 실측(2026-09-03): 유료 15,701곳 중 1,320곳이 기본시간을 60분 배수로 잡았고
 * 562곳은 1,440분이다. 그대로 "1440분"이라고 적으면 읽히지 않는다.
 */
function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}분`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}시간` : `${hours}시간 ${rest}분`
}

/**
 * 요금표를 사람이 읽는 문장으로. "30분 1,000원 + 15분 500원"
 * 값이 모자라면 null — 지어내지 않는다.
 */
function feeTableCaption(pricing: ParkingLot['pricing']): string | null {
  const { baseTime, baseFee, extraTime, extraFee } = pricing
  if (baseTime <= 0) return null
  const base = `${formatMinutes(baseTime)} ${baseFee.toLocaleString()}원`
  if (extraTime <= 0 || extraFee <= 0) return base
  return `${base} + ${formatMinutes(extraTime)} ${extraFee.toLocaleString()}원`
}

/**
 * 히어로 운영시간 칸.
 *
 * `formatOperatingHours` 를 그대로 쓰지 않는다 — 그쪽은 `평일 09:00-18:00` 처럼 라벨이
 * 값에 붙어 있어 라벨·값·캡션이 따로 노는 KPI 칸에 맞지 않는다.
 *
 * 캡션은 평일과 다른 요일만 적는다. 세 요일이 같은 lot 이 대부분이라(MODU 백필은 평일
 * 값을 토·공휴일에 그대로 복사한다) 매번 `토 09:00-21:00 · 공휴일 09:00-21:00` 을
 * 늘어놓으면 읽을 게 없는 줄이 된다.
 */
function hoursKpi(hours: ParkingLot['operatingHours']): Kpi {
  const weekday = formatTimeRange(hours.weekday)
  const saturday = formatTimeRange(hours.saturday)
  const holiday = formatTimeRange(hours.holiday)

  // 평일을 모르면 아는 요일을 대신 세운다 — 칸을 비우는 것보다 낫다
  const primary = weekday
    ? { label: '평일 운영', value: weekday }
    : saturday
      ? { label: '토요일 운영', value: saturday }
      : holiday
        ? { label: '공휴일 운영', value: holiday }
        : null

  if (!primary)
    return { key: 'hours', group: 'hours', label: '운영 시간', value: '정보 없음', muted: true }

  const satDiffers = Boolean(saturday && saturday !== weekday)
  const holDiffers = Boolean(holiday && holiday !== weekday)

  let caption: string | undefined
  if (!weekday) {
    caption = undefined
  } else if (satDiffers && holDiffers && saturday === holiday) {
    // 평일만 다르고 주말·공휴일이 같은 흔한 모양. 같은 시각을 두 번 적지 않는다
    caption = `토·공휴일 ${saturday}`
  } else if (satDiffers || holDiffers) {
    caption = [satDiffers ? `토 ${saturday}` : null, holDiffers ? `공휴일 ${holiday}` : null]
      .filter((s): s is string => s !== null)
      .join(' · ')
  } else if (saturday === weekday && holiday === weekday) {
    caption = '토·공휴일 동일'
  }

  return { key: 'hours', group: 'hours', ...primary, caption }
}

/**
 * 히어로 지표.
 *
 * 근거가 없는 칸은 **아예 그리지 않는다**. 요금표가 없는 주차장에
 * `base_fee × 60 / base_time` 같은 근사값을 채워 넣던 것이 유료 주차장의 33% 에서
 * 틀린 금액을 보여주고 있었다 (`parking-fee.ts` 참조).
 */
function buildKpis(lot: ParkingLot, realReviewCount: number, webCount: number): Kpi[] {
  const kpis: Kpi[] = []

  // 네 칸은 **항상** 그린다.
  //
  // 예전에는 값이 없으면 칸을 통째로 뺐다. 그랬더니 스타필드시티 위례처럼
  // daily_max·total_spaces 가 비어 있는 곳은 두 칸만 나와서, 우리가 그 값을 모르는 건지
  // 애초에 그런 항목이 없는 건지 구분되지 않았다. "정보 없음"은 값을 지어내는 게 아니라
  // 모른다고 말하는 것이다.

  // ① 요금 — 시간제면 1시간 예상, 정액제면 정액. 1일 최대는 캡션으로 딸려 붙는다.
  //
  // 기본시간이 하루 이상인 곳(실측 562곳)은 "1시간 예상"이라고 쓰면 안 된다.
  // 1시간을 대도 종일 요금을 내는 곳이라 라벨이 사실과 다르다.
  //
  // 「1일 최대」는 2026-09-09 까지 독립된 칸이었다. 그 칸이 비어 있는 lot 이 23,817곳
  // (44%)으로 네 칸 중 가장 자주 「정보 없음」이었고, 무료 주차장에서는 요금 칸과 함께
  // 「무료」를 두 번 쓰고 있었다. 요금 캡션으로 접고 그 자리에 운영시간을 세운다.
  const hourEstimate = lot.pricing.isFree ? null : estimateFee(lot.pricing, ESTIMATE_MINUTES)
  const isFlatRate = !lot.pricing.isFree && lot.pricing.baseTime >= MINUTES_PER_DAY
  const dailyMax = lot.pricing.dailyMax

  if (lot.pricing.isFree) {
    kpis.push({ key: 'fee', group: 'fee', label: '주차 요금', value: '무료', caption: '종일 무료' })
  } else if (hourEstimate !== null) {
    // 정액제이거나 1시간 예상과 금액이 같으면 1일 최대를 다시 쓰지 않는다 — 같은 말이다.
    const showDaily = dailyMax && dailyMax > 0 && !isFlatRate && dailyMax !== hourEstimate
    const captions = [
      feeTableCaption(lot.pricing),
      showDaily ? `1일 최대 ${dailyMax.toLocaleString()}원` : null,
    ].filter((s): s is string => s !== null)
    kpis.push({
      key: 'fee',
      group: 'fee',
      label: isFlatRate ? '종일 정액' : '1시간 예상',
      value: hourEstimate.toLocaleString(),
      unit: '원',
      caption: captions.length > 0 ? captions.join(' · ') : undefined,
    })
  } else if (dailyMax && dailyMax > 0) {
    // 요금표는 없는데 1일 최대만 아는 곳 (실측 127곳). 아는 값을 버리지 않는다.
    kpis.push({
      key: 'fee',
      group: 'fee',
      label: '1일 최대',
      value: dailyMax.toLocaleString(),
      unit: '원',
      caption: '시간당 요금 정보 없음',
    })
  } else {
    kpis.push({ key: 'fee', group: 'fee', label: '주차 요금', value: '정보 없음', muted: true })
  }

  // ② 운영 시간
  //
  // 무료 주차장이라고 칸의 **의미를 바꾸지 않는다**. 같은 자리에 늘 같은 항목이 있어야
  // 여러 주차장을 오가며 볼 때 헷갈리지 않는다.
  kpis.push(hoursKpi(lot.operatingHours))

  // ③ 주차면
  if (lot.totalSpaces > 0) {
    kpis.push({
      key: 'spaces',
      group: 'spaces',
      label: '주차면',
      value: lot.totalSpaces.toLocaleString(),
      unit: '면',
    })
  } else {
    kpis.push({ key: 'spaces', group: 'spaces', label: '주차면', value: '정보 없음', muted: true })
  }

  // ④ 쉬움 점수 — 이용자 후기·웹 후기·구조 정보를 합친 통합 점수 (`parking_lot_stats.final_score`)
  //
  // 예전엔 이 칸이 「이용자 별점」이었고 웹 후기 어조는 아래 「평가」에서 따로 그렸다.
  // "여기 주차가 어떤가" 하나에 숫자를 두 개 내놓는 셈이라 하나로 합쳤다(2026-09-04).
  // 목록 카드·FAQ 가 이미 이 값을 「쉬움 점수」로 부르고 있어 이름을 맞춘다.
  //
  // ⚠️ 별 아이콘·`/5` 를 쓰지 않는다. 웹 감성은 AI 추정값이라 별점처럼 보이면 안 되고,
  //    구조화 데이터(AggregateRating)에도 이 값을 내보내지 않는다 — 그건 실사용자 별점만.
  // ⚠️ 신호가 모자라면(`reliability` 가 confirmed/estimated 가 아니면) `final_score` 는
  //    3.0 prior 에 가깝다. 그 값을 점수처럼 내보내면 안 된다 — `—` 로 둔다.
  // ⚠️ 리뷰가 1~2건일 땐 prior(PRIOR_C=2.5)에 끌려 이용자 별점과 0.5 이상 벌어질 수 있다
  //    (로컬 실측 2026-09-04: 실리뷰 1건 lot 10곳 중 9곳, 평균 차 0.88). 캡션에 구성을
  //    밝혀 두는 이유다. PRIOR_C 조정은 시뮬레이션 후 별도 결정 — scoring-recompute.design.md §10.
  const { score, reliability } = lot.difficulty
  const hasSignal = score !== null && (reliability === 'confirmed' || reliability === 'estimated')
  if (hasSignal) {
    const basis = [
      realReviewCount > 0 ? `이용자 ${realReviewCount.toLocaleString()}명` : null,
      webCount > 0 ? `참고한 글 ${webCount.toLocaleString()}건` : null,
    ].filter((s): s is string => s !== null)
    kpis.push({
      key: 'score',
      label: '쉬움 점수',
      value: score.toFixed(1),
      caption: basis.length > 0 ? basis.join(' · ') : '후기 종합',
    })
  } else {
    kpis.push({
      key: 'score',
      label: '쉬움 점수',
      value: '—',
      caption: '첫 후기를 기다립니다',
      muted: true,
    })
  }

  return kpis
}

export function LotHeroSection({
  lot,
  realReviewCount,
  webCount,
  fieldSources = DEFAULT_FIELD_SOURCES,
  onEdited,
}: {
  lot: ParkingLot
  /** 각 칸의 값이 어디서 왔나 — 「유저제보」 배지를 붙일지 가른다 */
  fieldSources?: FieldSources
  /** 제보가 즉시 반영됐을 때. 라우터를 다시 읽어 새 값을 세운다 */
  onEdited?: () => void
  /** 실사용자(is_seed=0) 후기 수 — 캡션용. `difficulty.reviewCount` 는 시드를 포함해 쓰지 않는다 */
  realReviewCount: number
  /**
   * 참고한 웹 글 수 — `tabCounts.blog`(relevance≥40 · 애그리게이터 제외, LIMIT 없음).
   * 「후기 종합」의 "N건 정리" 와 같은 값을 넘긴다. 목록(`webSources.sources`)은 30건에서
   * 잘리므로 그 길이를 쓰면 글이 많은 lot 일수록 적게 보인다.
   * 점수 입력(`web_count`, relevance>30 · filter_v2)과는 기준이 달라 「참고한 글」로 부른다.
   */
  webCount: number
}) {
  const kpis = buildKpis(lot, realReviewCount, webCount)
  const score = lot.difficulty.score
  const perk = lot.notes?.trim() || null
  const [editing, setEditing] = useState<FieldGroup | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        {/* 시안 `.pills` — shadcn Badge 대신 11px/700 알약. 페이지에서 처음 눈에 닿는 요소다 */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={lot.pricing.isFree ? 'good' : 'accent'}>
            {lot.pricing.isFree ? '무료' : '유료'}
          </Pill>
          <Pill>{lot.type}</Pill>
          {score !== null && score >= 4.0 && (
            <Pill tone="good">
              <ThumbsUp className="size-3" />
              초보 추천
            </Pill>
          )}
          {score !== null && score < 2.0 && (
            <Pill tone="risk">
              <Flame className="size-3" />
              초보 주의
            </Pill>
          )}
        </div>
        <h1 className="m-0 text-[25px] font-extrabold leading-tight tracking-[-0.02em] text-ink">
          {lot.name}
        </h1>
        <div className="flex items-start gap-1.5 text-[13px] text-muted-foreground">
          <MapPin className="mt-0.5 size-3.5 shrink-0" />
          <span>{lot.address}</span>
        </div>
      </div>

      {perk && (
        // 「CGV 이용 시 최대 5시간 무료」 같은 회차·할인 조건. DB `notes` 에 3,381곳이 갖고 있다.
        // 요금만큼 결정에 직접 쓰이는 값이라 지표 바로 위에 둔다.
        //
        // 틴트 박스로 감싸지 않는다 — 시트 안에 표면을 하나 더 얹는 꼴이고(디자인 규칙 §5),
        // 색 있는 바탕 위 본문은 읽기 어렵다. 색은 라벨 한 조각에만 쓴다.
        <p className="text-[13px] leading-relaxed text-ink-2">
          <span className="mr-1.5 font-bold text-good">혜택</span>
          {perk}
        </p>
      )}

      {kpis.length > 0 && (
        <DividerGrid
          cols={Math.min(kpis.length, 4)}
          className="rounded-[10px]"
          data-testid="kpi-grid"
        >
          {kpis.map((kpi) => {
            // 제보할 수 있는 칸은 **칸 자체가 버튼**이다. 연필 아이콘을 네 개 늘어놓는
            // 것보다 조용하고, 좁은 화면에서 누를 자리가 넓다.
            //
            // 빈 칸에만 `+ 정보 추가` 를 덧붙인다 — 즉시 반영되는 자리이고 결손이
            // 가장 많다(면수 41% · 운영시간 20% · 요금 19%). 값이 있는 칸은 눌러서
            // 수정 제안만 되므로 라벨 없이 hover 로만 알린다.
            const clickable = Boolean(kpi.group)
            const fillable = Boolean(kpi.group && kpi.muted)
            const source = kpi.group ? fieldSources[kpi.group] : 'official'
            const body = (
              <>
                <span className="text-[10.5px] font-semibold tracking-[0.04em] text-muted-foreground">
                  {kpi.label}
                </span>
                <span
                  className={`text-[20px] font-extrabold leading-[1.2] tracking-[-0.02em] tabular-nums ${kpi.muted ? 'text-faint' : 'text-ink'}`}
                >
                  {kpi.value}
                  {kpi.unit && (
                    <span className="ml-0.5 text-[13px] font-bold text-muted-foreground">
                      {kpi.unit}
                    </span>
                  )}
                </span>
                {fillable ? (
                  <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-accent-ink">
                    <Plus className="size-3" />
                    정보 추가
                  </span>
                ) : (
                  <span className="flex flex-wrap items-center gap-1">
                    {source === 'user' && (
                      <span className="rounded-full bg-accent-tint px-1.5 py-px text-[10px] font-bold text-accent-ink">
                        유저제보
                      </span>
                    )}
                    {kpi.caption && <span className="text-[11px] text-faint">{kpi.caption}</span>}
                  </span>
                )}
              </>
            )

            return clickable ? (
              <DividerCell key={kpi.key} className="p-0">
                <button
                  type="button"
                  onClick={() => setEditing(kpi.group ?? null)}
                  className="flex h-full w-full cursor-pointer flex-col items-start gap-[3px] px-3.5 py-[13px] text-left transition-colors hover:bg-zinc-50"
                >
                  {body}
                </button>
              </DividerCell>
            ) : (
              <DividerCell key={kpi.key} className="flex flex-col gap-[3px]">
                {body}
              </DividerCell>
            )
          })}
        </DividerGrid>
      )}

      {/* 칸을 누르면 그 항목의 폼이 열린다는 걸 알린다. 예전에는 여기가 버튼이었는데
          요금 폼으로만 갈 수 있어서, 운영시간·면수가 틀린 경우엔 갈 데가 없었다. */}
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
          <Pencil className="size-3" />
          정보가 틀렸나요? 칸을 누르면 수정을 제안할 수 있어요
        </span>
        {toast && <span className="text-[11.5px] font-semibold text-good">{toast}</span>}
      </div>

      <FieldEditSheet
        lot={lot}
        group={editing}
        fieldSources={fieldSources}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        onSubmitted={(status) => {
          setToast(status === 'applied' ? '반영됐어요' : '접수됐어요 · 확인 후 반영돼요')
          setTimeout(() => setToast(null), 4000)
          if (status === 'applied') onEdited?.()
        }}
      />
    </div>
  )
}

/** 시안 `.pill` — 11px/700, 완전 둥근 모서리, 연한 색 채움 */
function Pill({
  children,
  tone = 'neutral',
}: {
  children: React.ReactNode
  tone?: 'neutral' | 'accent' | 'good' | 'risk'
}) {
  const TONE = {
    neutral: 'bg-hair-2 text-ink-2',
    accent: 'bg-accent-tint text-accent-ink',
    good: 'bg-good-tint text-good',
    risk: 'bg-risk-tint text-risk',
  } as const
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2.5 py-[3px] text-[11px] font-bold ${TONE[tone]}`}
    >
      {children}
    </span>
  )
}
