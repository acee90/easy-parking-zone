import useEmblaCarousel from 'embla-carousel-react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'

export function Carousel({ children }: { children: ReactNode }) {
  const [emblaRef, emblaApi] = useEmblaCarousel({
    align: 'start',
    containScroll: 'trimSnaps',
    dragFree: false,
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

  return (
    <div className="relative">
      <div className="-mx-4 overflow-hidden px-[6vw] sm:mx-0 sm:px-0" ref={emblaRef}>
        <div className="flex items-stretch gap-3">{children}</div>
      </div>

      {/* Desktop Arrows */}
      {canScrollPrev && (
        <button
          type="button"
          onClick={() => emblaApi?.scrollPrev()}
          className="absolute left-2 top-1/2 -translate-y-1/2 hidden sm:flex size-9 items-center justify-center rounded-full bg-white border shadow-sm text-gray-600 hover:bg-gray-50 z-10 cursor-pointer"
          aria-label="이전"
        >
          <ChevronLeft className="size-5" />
        </button>
      )}
      {canScrollNext && (
        <button
          type="button"
          onClick={() => emblaApi?.scrollNext()}
          className="absolute right-2 top-1/2 -translate-y-1/2 hidden sm:flex size-9 items-center justify-center rounded-full bg-white border shadow-sm text-gray-600 hover:bg-gray-50 z-10 cursor-pointer"
          aria-label="다음"
        >
          <ChevronRight className="size-5" />
        </button>
      )}

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
  let sizeClass = 'basis-[85vw] sm:basis-[380px] md:basis-[400px]'

  if (size === 'ranking') {
    sizeClass = 'basis-[75vw] sm:basis-[280px] md:basis-[300px]'
  }

  return <div className={`flex min-w-0 shrink-0 grow-0 ${sizeClass}`}>{children}</div>
}
