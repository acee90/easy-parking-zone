import { useState } from 'react'
import { StarDisplay } from './StarDisplay'

interface StarRatingInputProps {
  value: number
  onChange: (next: number) => void
  size?: 'sm' | 'md' | 'lg'
}

/** 0.5점 단위 입력. 별 좌/우 절반 호버/클릭 영역 분리 */
export function StarRatingInput({ value, onChange, size = 'lg' }: StarRatingInputProps) {
  const [hover, setHover] = useState<number | null>(null)
  const display = hover ?? value

  const handleKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault()
      onChange(Math.max(0.5, value - 0.5))
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault()
      onChange(Math.min(5, value + 0.5))
    } else if (e.key === 'Home') {
      e.preventDefault()
      onChange(0.5)
    } else if (e.key === 'End') {
      e.preventDefault()
      onChange(5)
    }
  }

  return (
    <div
      role="slider"
      aria-label="평점"
      aria-valuemin={0.5}
      aria-valuemax={5}
      aria-valuenow={value}
      aria-valuetext={`${value}점 / 5점`}
      tabIndex={0}
      onKeyDown={handleKey}
      onMouseLeave={() => setHover(null)}
      className="relative inline-flex items-center gap-0.5 rounded outline-none focus-visible:ring-2 focus-visible:ring-yellow-400"
    >
      <StarDisplay score={display} size={size} />
      <div className="absolute inset-0 flex">
        {[1, 2, 3, 4, 5].map((n) => (
          <div key={n} className="flex flex-1">
            <button
              type="button"
              aria-label={`${n - 0.5}점`}
              onMouseEnter={() => setHover(n - 0.5)}
              onClick={() => onChange(n - 0.5)}
              className="flex-1 cursor-pointer"
            />
            <button
              type="button"
              aria-label={`${n}점`}
              onMouseEnter={() => setHover(n)}
              onClick={() => onChange(n)}
              className="flex-1 cursor-pointer"
            />
          </div>
        ))}
      </div>
    </div>
  )
}
