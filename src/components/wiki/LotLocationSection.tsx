import { Clock, Phone, Tag } from 'lucide-react'
import { ParkingActionGroup } from '@/components/ParkingActionGroup'
import { WikiMiniMap } from '@/components/WikiMiniMap'
import { SectionShell } from '@/components/wiki/SectionShell'
import { formatOperatingHours, formatPhone } from '@/lib/parking-display'
import type { ParkingLot } from '@/types/parking'

/**
 * 위치 — 지도 · 길찾기 · 방문 전 확인 항목
 *
 * 예전에는 지도를 히어로 오른쪽에 붙여 정보 4 : 지도 6 으로 나눴다.
 * 지도를 전폭으로 내리면 이름·지표가 한 줄로 펴지고 지도도 넓어진다.
 *
 * 운영시간이 여기 있는 이유: 구조화 데이터로 `openingHoursSpecification` 을 내보내는데
 * 화면에 없으면 **검색엔진에만 보이는 값**이 된다. 별점 마크업에서 이미 한 번 겪은 문제다.
 */
export function LotLocationSection({ lot }: { lot: ParkingLot }) {
  const operatingHours = formatOperatingHours(lot.operatingHours)
  const phoneLabel = formatPhone(lot.phone)

  return (
    <SectionShell title="위치" sub="지도 · 로드뷰">
      <div className="flex flex-col gap-3">
        <WikiMiniMap lat={lot.lat} lng={lot.lng} name={lot.name} />

        <div className="flex flex-wrap items-center gap-2">
          <ParkingActionGroup
            lat={lot.lat}
            lng={lot.lng}
            name={lot.name}
            navigationButtonClassName="h-[38px]"
          />
          {phoneLabel && (
            <a
              href={`tel:${phoneLabel}`}
              aria-label={`전화 ${phoneLabel}`}
              className="inline-flex h-[38px] shrink-0 items-center justify-center gap-1.5 rounded-full bg-hair-2 px-3.5 text-[12.5px] font-semibold text-ink-2 transition-colors hover:bg-hair active:bg-hair"
            >
              <Phone className="size-3.5 shrink-0" />
              <span className="hidden sm:inline">{phoneLabel}</span>
            </a>
          )}
        </div>

        <div className="flex flex-col gap-2 text-[13px] sm:flex-row sm:flex-wrap sm:items-start sm:gap-x-6">
          <div className="flex items-start gap-2">
            <Clock className="mt-0.5 size-3.5 shrink-0 text-faint" />
            <div>
              <div className={operatingHours.isUnknown ? 'text-faint' : 'text-ink-2'}>
                {operatingHours.primary}
              </div>
              {operatingHours.secondary && (
                <div className="text-[11.5px] text-faint">{operatingHours.secondary}</div>
              )}
            </div>
          </div>

          {lot.poiTags && lot.poiTags.length > 0 && (
            <div className="flex items-start gap-2">
              <Tag className="mt-0.5 size-3.5 shrink-0 text-faint" />
              <div className="flex flex-wrap gap-1.5">
                {lot.poiTags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full bg-hair-2 px-2.5 py-[3px] text-[11px] font-bold text-ink-2"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </SectionShell>
  )
}
