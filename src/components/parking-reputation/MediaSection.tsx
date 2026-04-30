import { useEffect, useState } from 'react'
import { fetchParkingMedia } from '@/server/parking'
import type { ParkingMedia } from '@/types/parking'
import { Carousel, CarouselSlide } from './Carousel'
import { LoadingState } from './LoadingState'
import { MediaCard } from './MediaCard'
import { SectionTitle } from './SectionTitle'

interface MediaSectionProps {
  lotId: string
  count: number
  initialMedia?: ParkingMedia[]
  showTitle?: boolean
  className?: string
}

export function MediaSection({
  lotId,
  count,
  initialMedia,
  showTitle = true,
  className,
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

  return (
    <section className={className}>
      {showTitle && <SectionTitle title="영상" count={count} />}

      {media.length > 0 ? (
        <Carousel>
          {media.map((item) => (
            <CarouselSlide key={item.id} size="media">
              <MediaCard media={item} lotId={lotId} />
            </CarouselSlide>
          ))}
        </Carousel>
      ) : loading ? (
        <LoadingState />
      ) : (
        <p className="py-6 text-center text-xs text-muted-foreground">관련 영상이 없습니다</p>
      )}
    </section>
  )
}
