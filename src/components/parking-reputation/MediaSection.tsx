import { useEffect, useState } from 'react'
import { fetchParkingMedia } from '@/server/parking'
import type { ParkingMedia } from '@/types/parking'
import { Carousel, CarouselArrows, CarouselProvider, CarouselSlide } from './Carousel'
import { LoadingState } from './LoadingState'
import { MediaCard } from './MediaCard'
import { SectionTitle } from './SectionTitle'

const CAROUSEL_LIMIT = 7

interface MediaSectionProps {
  lotId: string
  count: number
  initialMedia?: ParkingMedia[]
  showTitle?: boolean
  className?: string
  /** 흰 배경 컨텍스트에서 카드 테두리 표시 */
  bordered?: boolean
}

export function MediaSection({
  lotId,
  count,
  initialMedia,
  showTitle = true,
  className,
  bordered,
}: MediaSectionProps) {
  const [media, setMedia] = useState<ParkingMedia[]>(initialMedia ?? [])
  const [loading, setLoading] = useState(initialMedia === undefined)

  useEffect(() => {
    setMedia(initialMedia ?? [])
    if (initialMedia !== undefined) {
      setLoading(false)
      return
    }

    setLoading(true)
    fetchParkingMedia({ data: { parkingLotId: lotId } })
      .then(setMedia)
      .catch(() => setMedia([]))
      .finally(() => setLoading(false))
  }, [lotId, initialMedia])

  const visibleMedia = media.slice(0, CAROUSEL_LIMIT)

  return (
    <section className={className}>
      <CarouselProvider>
        {showTitle && <SectionTitle title="영상" count={count} actions={<CarouselArrows />} />}

        {visibleMedia.length > 0 ? (
          <Carousel>
            {visibleMedia.map((item) => (
              <CarouselSlide key={item.id} size="media">
                <MediaCard media={item} lotId={lotId} bordered={bordered} />
              </CarouselSlide>
            ))}
          </Carousel>
        ) : loading ? (
          <LoadingState />
        ) : (
          <p className="py-6 text-center text-xs text-muted-foreground">관련 영상이 없습니다</p>
        )}
      </CarouselProvider>
    </section>
  )
}
