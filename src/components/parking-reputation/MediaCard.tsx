import { ReportButton } from '@/components/ReportDialog'
import type { ParkingMedia } from '@/types/parking'
import { decodeHtmlEntities } from './utils'

export function MediaCard({ media, lotId }: { media: ParkingMedia; lotId: string }) {
  const title = media.title ? decodeHtmlEntities(media.title) : '제목 없음'
  const description = media.description ? decodeHtmlEntities(media.description) : ''

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden rounded-xl bg-muted transition-colors hover:bg-muted/80">
      <a
        href={media.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex h-full min-w-0 flex-col"
      >
        {media.thumbnailUrl ? (
          <img
            src={media.thumbnailUrl}
            alt=""
            className="h-48 w-full shrink-0 scale-105 object-cover sm:h-52 md:h-56"
            loading="lazy"
          />
        ) : (
          <div className="h-48 w-full shrink-0 bg-zinc-100 sm:h-52 md:h-56" />
        )}
        <div className="flex min-w-0 flex-1 flex-col p-4">
          <p className="mb-2 line-clamp-2 min-h-[2.75rem] pr-5 text-base font-semibold leading-snug text-gray-900">
            {title}
          </p>
          <p className="line-clamp-2 min-h-[2.5rem] text-sm leading-relaxed text-muted-foreground">
            {description}
          </p>
        </div>
      </a>
      <div className="absolute right-2 top-2">
        <ReportButton targetType="media" targetId={media.id} parkingLotId={lotId} />
      </div>
    </div>
  )
}
