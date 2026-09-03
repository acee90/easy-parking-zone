import { Star, StarHalf } from 'lucide-react'

interface StarDisplayProps {
  score: number
  size?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}

const SIZE_CLASS = {
  sm: 'size-3.5',
  md: 'size-4',
  lg: 'size-6',
  // 입력용. 손가락으로 반 칸을 정확히 누르려면 이 정도는 돼야 한다
  xl: 'size-9',
} as const

/** 0.5 단위 점수 표시. 풀별/반별/빈별 렌더 */
export function StarDisplay({ score, size = 'sm', className = '' }: StarDisplayProps) {
  const sizeClass = SIZE_CLASS[size]
  // 0.5 단위 반올림
  const rounded = Math.round(score * 2) / 2

  return (
    <div className={`flex gap-0.5 ${className}`}>
      {[1, 2, 3, 4, 5].map((n) => {
        if (rounded >= n) {
          return (
            <Star
              key={n}
              className={`${sizeClass} fill-yellow-400 text-yellow-400`}
              aria-hidden="true"
            />
          )
        }
        if (rounded >= n - 0.5) {
          return (
            <span key={n} className="relative inline-flex">
              <Star className={`${sizeClass} text-zinc-300`} aria-hidden="true" />
              <StarHalf
                className={`${sizeClass} absolute left-0 top-0 fill-yellow-400 text-yellow-400`}
                aria-hidden="true"
              />
            </span>
          )
        }
        return <Star key={n} className={`${sizeClass} text-zinc-300`} aria-hidden="true" />
      })}
    </div>
  )
}
