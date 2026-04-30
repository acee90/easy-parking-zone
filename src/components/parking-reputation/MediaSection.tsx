import { useEffect, useState } from 'react'
import { fetchParkingMedia } from '@/server/parking'
import type { ParkingMedia } from '@/types/parking'
import { Carousel, CarouselSlide } from './Carousel'
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
  viewAllSlug?: string
}

export function MediaSection({
  lotId,
  count,
  initialMedia,
  showTitle = true,
  className,
  viewAllSlug,
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
  const hasMore = media.length > CAROUSEL_LIMIT || count > CAROUSEL_LIMIT

  return (
    <section className={className}>
      {showTitle && (
        <SectionTitle
          title="영상"
          count={count}
          viewAll={hasMore && viewAllSlug ? { slug: viewAllSlug, tab: 'media' } : undefined}
        />
      )}

      {visibleMedia.length > 0 ? (
        <Carousel>
          {visibleMedia.map((item) => (
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
