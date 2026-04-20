import { Check, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import type { DifficultyFilter, FeeRange, ParkingFilters } from '@/types/parking'

interface MobileFilterSheetProps {
  filters: ParkingFilters
  onToggle: (key: 'freeOnly' | 'publicOnly' | 'excludeNoSang' | 'openNow') => void
  onToggleDifficulty: (key: keyof DifficultyFilter) => void
  onSetFeeRange: (range: FeeRange) => void
  onToggleMinSpaces: () => void
  activeCount: number
}

const TOGGLE_OPTIONS: {
  key: 'freeOnly' | 'publicOnly' | 'excludeNoSang' | 'openNow'
  label: string
}[] = [
  { key: 'freeOnly', label: '무료만' },
  { key: 'publicOnly', label: '공영만' },
  { key: 'excludeNoSang', label: '노상 제외' },
  { key: 'openNow', label: '지금 영업중' },
]

const FEE_OPTIONS: { value: FeeRange; label: string }[] = [
  { value: 'any', label: '전체' },
  { value: '3000', label: '1h 3,000원↓' },
  { value: '5000', label: '1h 5,000원↓' },
  { value: '10000', label: '1h 10,000원↓' },
]

const DIFFICULTY_OPTIONS: {
  key: keyof DifficultyFilter
  icon: string
  label: string
  desc: string
}[] = [
  { key: 'easy', icon: '😊', label: '초보추천', desc: '4.0~5.0점' },
  { key: 'decent', icon: '🙂', label: '무난', desc: '3.3~3.9점' },
  { key: 'normal', icon: '😐', label: '보통', desc: '2.7~3.2점' },
  { key: 'bad', icon: '😕', label: '별로', desc: '2.0~2.6점' },
  { key: 'hard', icon: '💀', label: '비추', desc: '1.5~1.9점' },
  { key: 'hell', icon: '🔥', label: '헬', desc: '1.0~1.4점' },
]

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[10px] font-semibold tracking-[0.15em] uppercase text-stone-400 mb-2">
      {children}
    </div>
  )
}

export function MobileFilterSheet({
  filters,
  onToggle,
  onToggleDifficulty,
  onSetFeeRange,
  onToggleMinSpaces,
  activeCount,
}: MobileFilterSheetProps) {
  const [open, setOpen] = useState(false)

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <button
          type="button"
          aria-label="필터 열기"
          className="relative flex size-10 items-center justify-center rounded-full bg-white shadow-md border border-border"
        >
          <SlidersHorizontal className="size-4 text-zinc-700" />
          {activeCount > 0 && (
            <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white">
              {activeCount}
            </span>
          )}
        </button>
      </SheetTrigger>

      <SheetContent side="bottom" className="max-h-[85vh] rounded-t-2xl overflow-y-auto pb-safe">
        <SheetHeader className="px-5 pt-5 pb-0">
          <SheetTitle className="text-base">필터</SheetTitle>
        </SheetHeader>

        <div className="px-5 pb-6 pt-4 space-y-6">
          {/* 빠른 토글 */}
          <div>
            <SectionLabel>빠른 필터</SectionLabel>
            <div className="grid grid-cols-2 gap-2">
              {TOGGLE_OPTIONS.map(({ key, label }) => (
                <button
                  type="button"
                  key={key}
                  onClick={() => onToggle(key)}
                  className={`rounded-full px-3 py-2 text-sm font-medium border transition-colors ${
                    filters[key]
                      ? 'bg-blue-500 text-white border-blue-500'
                      : 'bg-white text-zinc-700 border-zinc-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 요금 범위 */}
          <div>
            <SectionLabel>요금 (1시간 기준)</SectionLabel>
            <div className="grid grid-cols-2 gap-2">
              {FEE_OPTIONS.map(({ value, label }) => (
                <button
                  type="button"
                  key={value}
                  onClick={() => onSetFeeRange(value)}
                  className={`rounded-full px-3 py-2 text-sm font-medium border transition-colors ${
                    filters.feeRange === value
                      ? 'bg-blue-500 text-white border-blue-500'
                      : 'bg-white text-zinc-700 border-zinc-200'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* 규모 */}
          <div>
            <SectionLabel>규모</SectionLabel>
            <button
              type="button"
              onClick={onToggleMinSpaces}
              className={`w-full rounded-full px-3 py-2 text-sm font-medium border transition-colors ${
                filters.minSpaces !== null
                  ? 'bg-blue-500 text-white border-blue-500'
                  : 'bg-white text-zinc-700 border-zinc-200'
              }`}
            >
              50면 이상만
            </button>
          </div>

          {/* 난이도 */}
          <div>
            <SectionLabel>난이도</SectionLabel>
            <div className="space-y-1">
              {DIFFICULTY_OPTIONS.map(({ key, icon, label, desc }) => {
                const checked = filters.difficulty[key]
                return (
                  <button
                    type="button"
                    key={key}
                    onClick={() => onToggleDifficulty(key)}
                    className="flex w-full items-center gap-3 px-2 py-2.5 rounded-lg hover:bg-zinc-50 transition-colors"
                  >
                    <span
                      className={`flex size-5 shrink-0 items-center justify-center rounded border transition-colors ${
                        checked ? 'bg-blue-500 border-blue-500' : 'border-zinc-300 bg-white'
                      }`}
                    >
                      {checked && <Check className="size-3.5 text-white" strokeWidth={3} />}
                    </span>
                    <span className="text-lg leading-none">{icon}</span>
                    <div className="flex flex-col items-start">
                      <span
                        className={`text-sm font-medium ${checked ? 'text-zinc-900' : 'text-zinc-400'}`}
                      >
                        {label}
                      </span>
                      <span className="text-[11px] text-zinc-400">{desc}</span>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}
