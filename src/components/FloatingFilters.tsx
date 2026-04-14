import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { DifficultyFilter, FeeRange, ParkingFilters } from '@/types/parking'

interface FloatingFiltersProps {
  filters: ParkingFilters
  onToggle: (key: 'freeOnly' | 'publicOnly' | 'excludeNoSang' | 'openNow') => void
  onToggleDifficulty: (key: keyof DifficultyFilter) => void
  onSetFeeRange: (range: FeeRange) => void
  onToggleMinSpaces: () => void
  activeCount: number
}

const FILTER_OPTIONS: {
  key: 'freeOnly' | 'publicOnly' | 'excludeNoSang' | 'openNow'
  label: string
}[] = [
  { key: 'freeOnly', label: '무료만' },
  { key: 'publicOnly', label: '공영만' },
  { key: 'excludeNoSang', label: '노상 제외' },
  { key: 'openNow', label: '지금 영업중' },
]

const FEE_OPTIONS: { value: FeeRange; label: string }[] = [
  { value: 'any', label: '요금 전체' },
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

export function FloatingFilters({
  filters,
  onToggle,
  onToggleDifficulty,
  onSetFeeRange,
  onToggleMinSpaces,
  activeCount,
}: FloatingFiltersProps) {
  const [diffOpen, setDiffOpen] = useState(false)
  const [feeOpen, setFeeOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const feeDropdownRef = useRef<HTMLDivElement>(null)
  const diffOff = Object.values(filters.difficulty).filter((v) => !v).length

  useEffect(() => {
    if (!diffOpen && !feeOpen) return
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDiffOpen(false)
      }
      if (feeDropdownRef.current && !feeDropdownRef.current.contains(e.target as Node)) {
        setFeeOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [diffOpen, feeOpen])

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex size-8 items-center justify-center rounded-full bg-white shadow-md border border-border relative">
        <SlidersHorizontal className="size-4 text-zinc-600" />
        {activeCount > 0 && (
          <span className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-blue-500 text-[10px] font-bold text-white">
            {activeCount}
          </span>
        )}
      </div>
      {FILTER_OPTIONS.map(({ key, label }) => (
        <button
          key={key}
          onClick={() => onToggle(key)}
          className={`rounded-full px-3 py-1.5 text-xs font-medium shadow-md border transition-colors ${
            filters[key]
              ? 'bg-blue-500 text-white border-blue-500'
              : 'bg-white text-zinc-700 border-border hover:bg-zinc-50'
          }`}
        >
          {label}
        </button>
      ))}

      {/* 요금 범위 드롭다운 */}
      <div className="relative" ref={feeDropdownRef}>
        <button
          onClick={() => setFeeOpen(!feeOpen)}
          className={`rounded-full px-3 py-1.5 text-xs font-medium shadow-md border transition-colors flex items-center gap-1 ${
            filters.feeRange !== 'any'
              ? 'bg-blue-500 text-white border-blue-500'
              : 'bg-white text-zinc-700 border-border hover:bg-zinc-50'
          }`}
        >
          {FEE_OPTIONS.find((o) => o.value === filters.feeRange)?.label ?? '요금'}
          <ChevronDown className={`size-3 transition-transform ${feeOpen ? 'rotate-180' : ''}`} />
        </button>

        {feeOpen && (
          <div className="absolute top-full left-0 mt-1.5 w-36 rounded-lg bg-white shadow-lg border border-border py-1 animate-in fade-in slide-in-from-top-1 duration-150 z-50">
            {FEE_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => {
                  onSetFeeRange(value)
                  setFeeOpen(false)
                }}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-zinc-50 transition-colors ${
                  filters.feeRange === value ? 'font-medium text-blue-600' : 'text-zinc-700'
                }`}
              >
                {filters.feeRange === value && <Check className="size-3 text-blue-500 shrink-0" />}
                <span className={filters.feeRange === value ? '' : 'pl-5'}>{label}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 50면 이상 토글 */}
      <button
        onClick={onToggleMinSpaces}
        className={`rounded-full px-3 py-1.5 text-xs font-medium shadow-md border transition-colors ${
          filters.minSpaces !== null
            ? 'bg-blue-500 text-white border-blue-500'
            : 'bg-white text-zinc-700 border-border hover:bg-zinc-50'
        }`}
      >
        50면+
      </button>

      {/* 난이도 드롭다운 */}
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setDiffOpen(!diffOpen)}
          className={`rounded-full px-3 py-1.5 text-xs font-medium shadow-md border transition-colors flex items-center gap-1 ${
            diffOff > 0
              ? 'bg-blue-500 text-white border-blue-500'
              : 'bg-white text-zinc-700 border-border hover:bg-zinc-50'
          }`}
        >
          난이도{diffOff > 0 && ` (${7 - diffOff})`}
          <ChevronDown className={`size-3 transition-transform ${diffOpen ? 'rotate-180' : ''}`} />
        </button>

        {diffOpen && (
          <div className="absolute top-full left-0 mt-1.5 w-48 rounded-lg bg-white shadow-lg border border-border py-1 animate-in fade-in slide-in-from-top-1 duration-150 z-50">
            {DIFFICULTY_OPTIONS.map(({ key, icon, label, desc }) => {
              const checked = filters.difficulty[key]
              return (
                <button
                  key={key}
                  onClick={() => onToggleDifficulty(key)}
                  className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-zinc-50 transition-colors"
                >
                  <span
                    className={`flex size-4 shrink-0 items-center justify-center rounded border transition-colors ${
                      checked ? 'bg-blue-500 border-blue-500' : 'border-zinc-300 bg-white'
                    }`}
                  >
                    {checked && <Check className="size-3 text-white" strokeWidth={3} />}
                  </span>
                  <span className="text-base leading-none">{icon}</span>
                  <span className="flex flex-col">
                    <span
                      className={`text-xs font-medium ${checked ? 'text-zinc-900' : 'text-zinc-400'}`}
                    >
                      {label}
                    </span>
                    <span className="text-[10px] text-zinc-400">{desc}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
