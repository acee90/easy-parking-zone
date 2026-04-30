import useEmblaCarousel from 'embla-carousel-react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useState } from 'react'

export function Carousel({ children }: { children: ReactNode }) {
  const [emblaRef, emblaApi] = useEmblaCarousel({
    align: 'center',
    containScroll: 'trimSnaps',
    dragFree: false,
  })
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [scrollSnaps, setScrollSnaps] = useState<number[]>([])

  const onSelect = useCallback(() => {
    if (!emblaApi) return
    setSelectedIndex(emblaApi.selectedScrollSnap())
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
    <div>
      <div className="-mx-4 overflow-hidden px-[6vw] sm:mx-0 sm:px-0" ref={emblaRef}>
        <div className="flex items-stretch gap-3">{children}</div>
      </div>
      {scrollSnaps.length > 1 && (
        <div className="mt-2 flex items-center justify-center gap-1.5 sm:hidden" aria-hidden="true">
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
  size?: 'review' | 'media'
}) {
  // review/media 모두 동일 basis로 통일 (이슈 #115 Phase 5)
  void size
  const sizeClass = 'basis-[85vw] sm:basis-[380px] md:basis-[400px]'

  return <div className={`flex min-w-0 shrink-0 grow-0 ${sizeClass}`}>{children}</div>
}
