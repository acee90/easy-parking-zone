import { Play } from 'lucide-react'
import { ReportButton } from '@/components/ReportDialog'
import type { ParkingMedia } from '@/types/parking'
import { decodeHtmlEntities } from './utils'

export function MediaCard({ media, lotId }: { media: ParkingMedia; lotId: string }) {
  const title = media.title ? decodeHtmlEntities(media.title) : '제목 없음'
  const description = media.description ? decodeHtmlEntities(media.description) : ''

  return (
    <div className="group relative flex h-full w-full flex-col overflow-hidden rounded-2xl border bg-white transition-all hover:shadow-md">
      <a
        href={media.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex h-full min-w-0 flex-col"
      >
        <div className="relative aspect-video w-full overflow-hidden bg-zinc-100">
          {media.thumbnailUrl ? (
            <img
              src={media.thumbnailUrl}
              alt=""
              className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Play className="size-10 text-zinc-300" />
            </div>
          )}
          <div className="absolute inset-0 flex items-center justify-center bg-black/10 opacity-0 transition-opacity group-hover:opacity-100">
            <div className="flex size-12 items-center justify-center rounded-full bg-red-600 text-white shadow-lg">
              <Play className="ml-0.5 size-6 fill-current" />
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-1 flex-col p-4">
          <p className="mb-2 line-clamp-2 text-base font-bold leading-snug text-zinc-900">
            {title}
          </p>
          {description && (
            <p className="line-clamp-2 text-sm leading-relaxed text-zinc-500">{description}</p>
          )}
        </div>
      </a>
      <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100">
        <ReportButton targetType="media" targetId={media.id} parkingLotId={lotId} />
      </div>
    </div>
  )
}
