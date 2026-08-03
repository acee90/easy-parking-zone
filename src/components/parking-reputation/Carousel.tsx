import useEmblaCarousel from 'embla-carousel-react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'

interface CarouselContextValue {
  emblaRef: ReturnType<typeof useEmblaCarousel>[0]
  scrollPrev: () => void
  scrollNext: () => void
  canScrollPrev: boolean
  canScrollNext: boolean
  selectedIndex: number
  scrollSnaps: number[]
}

const CarouselContext = createContext<CarouselContextValue | null>(null)

function useCarousel() {
  const ctx = useContext(CarouselContext)
  if (!ctx) throw new Error('Carousel/CarouselArrows는 <CarouselProvider> 안에서만 사용할 수 있다')
  return ctx
}

/**
 * 캐러셀 상태 공급자. 화살표를 슬라이드 위가 아니라 섹션 타이틀 행에 두기 위해
 * embla 인스턴스를 헤더와 뷰포트가 함께 쓸 수 있도록 분리했다.
 * 타이틀과 <Carousel>을 모두 감싸야 한다.
 */
export function CarouselProvider({ children }: { children: ReactNode }) {
  // 모바일: 활성 카드를 가운데 정렬해 양옆 카드가 살짝 보이게. 데스크톱: 화살표 탐색이라 start 정렬.
  const [emblaRef, emblaApi] = useEmblaCarousel({
    align: 'center',
    containScroll: 'trimSnaps',
    dragFree: false,
    breakpoints: { '(min-width: 640px)': { align: 'start' } },
  })
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [scrollSnaps, setScrollSnaps] = useState<number[]>([])
  const [canScrollPrev, setCanScrollPrev] = useState(false)
  const [canScrollNext, setCanScrollNext] = useState(false)

  const onSelect = useCallback(() => {
    if (!emblaApi) return
    setSelectedIndex(emblaApi.selectedScrollSnap())
    setCanScrollPrev(emblaApi.canScrollPrev())
    setCanScrollNext(emblaApi.canScrollNext())
  }, [emblaApi])

  useEffect(() => {
    if (!emblaApi) return
    setScrollSnaps(emblaApi.scrollSnapList())
    onSelect()
    emblaApi.on('select', onSelect)
    emblaApi.on('reInit', onSelect)
    return () => {
      emblaApi.off('select', onSelect)
      emblaApi.off('reInit', onSelect)
    }
  }, [emblaApi, onSelect])

  const value = useMemo<CarouselContextValue>(
    () => ({
      emblaRef,
      scrollPrev: () => emblaApi?.scrollPrev(),
      scrollNext: () => emblaApi?.scrollNext(),
      canScrollPrev,
      canScrollNext,
      selectedIndex,
      scrollSnaps,
    }),
    [emblaRef, emblaApi, canScrollPrev, canScrollNext, selectedIndex, scrollSnaps],
  )

  return <CarouselContext.Provider value={value}>{children}</CarouselContext.Provider>
}

/** 섹션 타이틀 행 우측에 놓는 이전/다음 버튼 (데스크톱 전용, 모바일은 하단 dots) */
export function CarouselArrows() {
  const { scrollPrev, scrollNext, canScrollPrev, canScrollNext } = useCarousel()

  // 스크롤할 것이 없으면 표시하지 않는다 (슬라이드가 한 화면에 다 들어오는 경우)
  if (!canScrollPrev && !canScrollNext) return null

  const buttonClass =
    'flex size-8 items-center justify-center rounded-full border border-zinc-200 bg-white text-zinc-700 transition-colors disabled:cursor-default disabled:border-zinc-100 disabled:bg-zinc-50 disabled:text-zinc-300 hover:enabled:bg-zinc-50 active:enabled:bg-zinc-100 cursor-pointer'

  return (
    <div className="hidden shrink-0 items-center gap-1 sm:flex">
      <button
        type="button"
        onClick={scrollPrev}
        disabled={!canScrollPrev}
        className={buttonClass}
        aria-label="이전"
      >
        <ChevronLeft className="size-4.5" />
      </button>
      <button
        type="button"
        onClick={scrollNext}
        disabled={!canScrollNext}
        className={buttonClass}
        aria-label="다음"
      >
        <ChevronRight className="size-4.5" />
      </button>
    </div>
  )
}

export function Carousel({ children }: { children: ReactNode }) {
  const { emblaRef, selectedIndex, scrollSnaps } = useCarousel()

  return (
    <div className="relative">
      <div className="-mx-4 overflow-hidden px-[6vw] sm:mx-0 sm:px-0" ref={emblaRef}>
        <div className="flex items-stretch gap-3">{children}</div>
      </div>

      {scrollSnaps.length > 1 && (
        <div className="mt-3 flex items-center justify-center gap-1.5 sm:hidden" aria-hidden="true">
          {scrollSnaps.map((snap, index) => (
            <span
              key={snap}
              className={`h-1.5 rounded-full transition-all ${
                index === selectedIndex ? 'w-4 bg-zinc-900' : 'w-1.5 bg-zinc-300'
              }`}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function CarouselSlide({
  children,
  size = 'review',
}: {
  children: ReactNode
  size?: 'review' | 'media' | 'ranking'
}) {
  let sizeClass = 'basis-[80%] sm:basis-[300px]'

  if (size === 'ranking') {
    sizeClass = 'basis-[78%] sm:basis-[300px]'
  }

  return <div className={`flex min-w-0 shrink-0 grow-0 ${sizeClass}`}>{children}</div>
}
